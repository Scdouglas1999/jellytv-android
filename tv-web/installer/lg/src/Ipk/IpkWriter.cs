using System.IO.Compression;
using System.Text;

namespace Tally.LgInstaller.Ipk;

/// <summary>
/// Writes a webOS .ipk the way LG's <c>ares-package</c> (@webos-tools/cli 3.2.6, lib/package.js) writes one for a web
/// app, without LG's tools:
/// <list type="bullet">
/// <item>an <c>ar</c> archive: <c>!&lt;arch&gt;\n</c>, then <c>debian-binary</c> ("2.0\n"), <c>control.tar.gz</c>,
/// <c>data.tar.gz</c>, each with a 60-byte header (name padded to 16, mtime, uid 0, gid 0, mode 100644, size, "`\n")
/// and a "\n" after odd-sized members (package.js <c>arFileHeader</c>, <c>makeIpk</c>);</item>
/// <item><c>control.tar.gz</c>: one file <c>control</c> with the fields package.js <c>createControlFile</c> writes
/// (Installed-Size = the bytes of the data files);</item>
/// <item><c>data.tar.gz</c>: <c>usr/palm/applications/&lt;id&gt;/…</c> (the app) and
/// <c>usr/palm/packages/&lt;id&gt;/packageinfo.json</c> (<c>{"id","version","app"}</c>), directories first, in
/// the ustar format node-tar writes (octal fields "000644 \0", atime/ctime in the prefix area).</item>
/// </list>
/// No signature: TVs in Developer Mode install unsigned packages (ares-package signs only for signage).
/// </summary>
public static class IpkWriter
{
    /// <summary>The .ipk for web app <paramref name="appId"/> with <paramref name="files"/> (paths relative to the app folder).</summary>
    public static byte[] Build(string appId, string version, IReadOnlyDictionary<string, byte[]> files, DateTimeOffset time)
    {
        if (!IsValidId(appId))
        {
            throw new ArgumentException($"\"{appId}\" is not a webOS app id", nameof(appId));
        }

        var appDir = "usr/palm/applications/" + appId + "/";
        var pkgDir = "usr/palm/packages/" + appId + "/";
        var packageInfo = Encoding.UTF8.GetBytes(
            "{\n  \"id\": \"" + appId + "\",\n  \"version\": \"" + version + "\",\n  \"app\": \"" + appId + "\"\n}\n");

        var data = new TarWriter(time);
        foreach (var dir in new[] { "usr/", "usr/palm/", "usr/palm/applications/", "usr/palm/packages/", appDir, pkgDir })
        {
            data.Directory(dir);
        }

        var dirs = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var path in files.Keys)
        {
            var parts = path.Split('/');
            for (var i = 1; i < parts.Length; i++)
            {
                dirs.Add(string.Join('/', parts[..i]) + "/");
            }
        }

        foreach (var dir in dirs)
        {
            data.Directory(appDir + dir);
        }

        long installed = packageInfo.Length;
        foreach (var (path, bytes) in files.OrderBy(f => f.Key, StringComparer.Ordinal))
        {
            data.File(appDir + path, bytes, 0b110_100_100);
            installed += bytes.Length;
        }

        data.File(pkgDir + "packageinfo.json", packageInfo, 0b110_110_110);

        var control = new TarWriter(time);
        control.File("control", Encoding.UTF8.GetBytes(ControlFile(appId, version, installed)), 0b110_110_110);

        return Ar(time, ("debian-binary", "2.0\n"u8.ToArray()), ("control.tar.gz", Gzip(control.Finish())),
            ("data.tar.gz", Gzip(data.Finish())));
    }

    /// <summary>The control file as ares-package writes it (package.js <c>createControlFile</c>).</summary>
    public static string ControlFile(string appId, string version, long installedSize) =>
        "Package: " + appId + "\n" +
        "Version: " + version + "\n" +
        "Section: misc\n" +
        "Priority: optional\n" +
        "Architecture: all\n" +
        "Installed-Size: " + installedSize + "\n" +
        "Maintainer: N/A <nobody@example.com>\n" +
        "Description: This is a webOS application.\n" +
        "webOS-Package-Format-Version: 2\n" +
        "webOS-Packager-Version: x.y.x\n";

    /// <summary>The file name ares-package gives it: <c>&lt;id&gt;_&lt;version&gt;_all.ipk</c>.</summary>
    public static string FileName(string appId, string version) => appId + "_" + version + "_all.ipk";

    /// <summary>webOS app ids: lowercase letters, digits, '.', '-', '+' (appinfo.json rules), starting with a letter or digit.</summary>
    public static bool IsValidId(string id) =>
        id.Length is > 0 and <= 128 && char.IsAsciiLetterOrDigit(id[0])
        && id.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '.' or '-' or '+');

    private static byte[] Ar(DateTimeOffset time, params (string Name, byte[] Bytes)[] members)
    {
        using var output = new MemoryStream();
        output.Write("!<arch>\n"u8);
        var mtime = time.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        foreach (var (name, bytes) in members)
        {
            var header = Pad(name, 16) + Pad(mtime, 12) + "0     " + "0     " + "100644  " +
                         Pad(bytes.Length.ToString(System.Globalization.CultureInfo.InvariantCulture), 10) + "`\n";
            output.Write(Encoding.ASCII.GetBytes(header));
            output.Write(bytes);
            if (bytes.Length % 2 != 0)
            {
                output.WriteByte((byte)'\n');
            }
        }

        return output.ToArray();
    }

    private static string Pad(string s, int width) => s.Length >= width ? s[..width] : s.PadRight(width);

    /// <summary>gzip with the header node's zlib writes (no name, mtime 0, OS 3), deflated at the best level.</summary>
    public static byte[] Gzip(byte[] bytes)
    {
        using var output = new MemoryStream();
        output.Write([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
        using (var deflate = new DeflateStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            deflate.Write(bytes);
        }

        Span<byte> trailer = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(trailer, Crc32(bytes));
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(trailer[4..], (uint)bytes.Length);
        output.Write(trailer);
        return output.ToArray();
    }

    private static readonly uint[] CrcTable = MakeCrcTable();

    private static uint[] MakeCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            }

            table[n] = c;
        }

        return table;
    }

    public static uint Crc32(ReadOnlySpan<byte> bytes)
    {
        var c = 0xFFFFFFFFu;
        foreach (var b in bytes)
        {
            c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        }

        return c ^ 0xFFFFFFFFu;
    }
}

/// <summary>A ustar archive as node-tar (ares-package's tar) writes it.</summary>
internal sealed class TarWriter(DateTimeOffset time)
{
    private readonly MemoryStream _out = new();
    private readonly long _mtime = time.ToUnixTimeSeconds();

    public void Directory(string path) => Entry(path.EndsWith('/') ? path : path + "/", [], 0b111_111_111, '5');

    public void File(string path, byte[] bytes, int mode) => Entry(path, bytes, mode, '0');

    private void Entry(string path, byte[] bytes, int mode, char type)
    {
        var header = new byte[512];
        var name = Encoding.UTF8.GetBytes(path);
        if (name.Length > 100)
        {
            throw new ArgumentException($"path too long for the package: {path}");
        }

        name.CopyTo(header, 0);
        Octal(header, 100, mode, 6, " \0");
        Octal(header, 108, 0, 6, " \0");
        Octal(header, 116, 0, 6, " \0");
        Octal(header, 124, bytes.Length, 10, " \0");
        Octal(header, 136, _mtime, 11, "\0");
        header[156] = (byte)type;
        "ustar\0"u8.CopyTo(header.AsSpan(257));
        "00"u8.CopyTo(header.AsSpan(263));
        Octal(header, 329, 0, 6, " \0");
        Octal(header, 337, 0, 6, " \0");
        // node-tar keeps atime and ctime in the prefix area (as star does)
        Octal(header, 476, _mtime, 11, "\0");
        Octal(header, 488, _mtime, 11, "\0");
        for (var i = 148; i < 156; i++)
        {
            header[i] = (byte)' ';
        }

        var sum = header.Sum(b => (long)b);
        Octal(header, 148, sum, 6, " \0");
        _out.Write(header);
        _out.Write(bytes);
        var pad = (512 - bytes.Length % 512) % 512;
        _out.Write(new byte[pad]);
    }

    private static void Octal(byte[] header, int offset, long value, int digits, string end)
    {
        var text = Convert.ToString(value, 8).PadLeft(digits, '0') + end;
        Encoding.ASCII.GetBytes(text).CopyTo(header, offset);
    }

    public byte[] Finish()
    {
        _out.Write(new byte[1024]);
        return _out.ToArray();
    }
}
