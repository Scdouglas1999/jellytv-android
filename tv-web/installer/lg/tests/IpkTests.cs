using System.IO.Compression;
using System.Text;
using Tally.LgInstaller.Ipk;
using Xunit;

namespace Tally.LgInstaller.Tests;

/// <summary>
/// The .ipk writer against a package LG's own ares-package (@webos-tools/cli 3.2.6) made of the same shell
/// (fixtures/golden/ares-package-shell.ipk: <c>scripts/package-webos.sh --server http://192.0.2.10:8096</c>).
/// Times, the packer's user name and the deflate bytes differ; the structure must not.
/// </summary>
public class IpkTests
{
    private static readonly byte[] Golden = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixtures/golden/ares-package-shell.ipk"));

    internal sealed record ArMember(string Header, string Name, byte[] Bytes);

    internal sealed record TarEntry(string Name, char Type, string Mode, string Uid, string Size, string Magic, string Version, byte[] Bytes, byte[] Header);

    internal static List<ArMember> ReadAr(byte[] ipk)
    {
        Assert.Equal("!<arch>\n", Encoding.ASCII.GetString(ipk, 0, 8));
        var list = new List<ArMember>();
        var at = 8;
        while (at < ipk.Length)
        {
            var header = Encoding.ASCII.GetString(ipk, at, 60);
            Assert.EndsWith("`\n", header);
            var size = int.Parse(header.Substring(48, 10).Trim(), System.Globalization.CultureInfo.InvariantCulture);
            list.Add(new ArMember(header, header[..16].TrimEnd(), ipk.AsSpan(at + 60, size).ToArray()));
            at += 60 + size + (size % 2);
        }

        return list;
    }

    internal static List<TarEntry> ReadTarGz(byte[] gz)
    {
        using var input = new GZipStream(new MemoryStream(gz), CompressionMode.Decompress);
        using var tar = new MemoryStream();
        input.CopyTo(tar);
        var d = tar.ToArray();
        var list = new List<TarEntry>();
        var at = 0;
        while (at + 512 <= d.Length && d[at] != 0)
        {
            string F(int o, int l) => Encoding.ASCII.GetString(d, at + o, l);
            var sizeField = F(124, 12);
            var size = Convert.ToInt32(sizeField.Trim(' ', '\0'), 8);
            list.Add(new TarEntry(F(0, 100).TrimEnd('\0'), (char)d[at + 156], F(100, 8), F(108, 8), sizeField, F(257, 6), F(263, 2),
                d.AsSpan(at + 512, size).ToArray(), d.AsSpan(at, 512).ToArray()));
            at += 512 + (size + 511) / 512 * 512;
        }

        // the end: two zero blocks
        Assert.True(d.Skip(at).Take(1024).All(b => b == 0));
        return list;
    }

    private static byte[] Ours()
    {
        // the same app files as the golden package
        var data = ReadTarGz(ReadAr(Golden)[2].Bytes);
        const string app = "usr/palm/applications/io.github.scdouglas1999.tally/";
        var files = data.Where(e => e.Type == '0' && e.Name.StartsWith(app, StringComparison.Ordinal))
            .ToDictionary(e => e.Name[app.Length..], e => e.Bytes);
        return IpkWriter.Build("io.github.scdouglas1999.tally", "0.1.0", files, DateTimeOffset.FromUnixTimeSeconds(1790366627));
    }

    [Fact]
    public void ArchiveHasTheMembersAndHeadersAresPackageWrites()
    {
        var golden = ReadAr(Golden);
        var ours = ReadAr(Ours());
        Assert.Equal(["debian-binary", "control.tar.gz", "data.tar.gz"], golden.Select(m => m.Name));
        Assert.Equal(golden.Select(m => m.Name), ours.Select(m => m.Name));
        for (var i = 0; i < 3; i++)
        {
            // name(16) mtime(12) uid(6) gid(6) mode(8) size(10) "`\n": all but mtime and size identical
            Assert.Equal(golden[i].Header[..16], ours[i].Header[..16]);
            Assert.Equal(golden[i].Header[28..48], ours[i].Header[28..48]);
            Assert.Equal(golden[i].Header[58..], ours[i].Header[58..]);
        }

        Assert.Equal("2.0\n", Encoding.ASCII.GetString(ours[0].Bytes));
        // gzip header as node's zlib: no name, mtime 0, OS 3
        Assert.Equal(golden[1].Bytes[..10], ours[1].Bytes[..10]);
        Assert.Equal(golden[2].Bytes[..10], ours[2].Bytes[..10]);
    }

    [Fact]
    public void ControlFileMatches()
    {
        var golden = ReadTarGz(ReadAr(Golden)[1].Bytes);
        var ours = ReadTarGz(ReadAr(Ours())[1].Bytes);
        Assert.Equal(["control"], golden.Select(e => e.Name));
        Assert.Equal(["control"], ours.Select(e => e.Name));
        string Without(string control) => string.Join('\n', control.Split('\n').Where(l => !l.StartsWith("Installed-Size", StringComparison.Ordinal)));
        Assert.Equal(Without(Encoding.UTF8.GetString(golden[0].Bytes)), Without(Encoding.UTF8.GetString(ours[0].Bytes)));
        Assert.Contains("Installed-Size: ", Encoding.UTF8.GetString(ours[0].Bytes));
        Assert.Equal(golden[0].Mode, ours[0].Mode);
    }

    [Fact]
    public void DataHasTheSameEntriesModesAndBytes()
    {
        var golden = ReadTarGz(ReadAr(Golden)[2].Bytes).OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
        var ours = ReadTarGz(ReadAr(Ours())[2].Bytes).OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
        Assert.Equal(golden.Select(e => e.Name), ours.Select(e => e.Name));
        for (var i = 0; i < golden.Count; i++)
        {
            Assert.Equal(golden[i].Type, ours[i].Type);
            Assert.Equal(golden[i].Mode, ours[i].Mode);
            Assert.Equal(golden[i].Size, ours[i].Size);
            Assert.Equal(golden[i].Magic, ours[i].Magic);
            Assert.Equal(golden[i].Version, ours[i].Version);
            Assert.Equal(golden[i].Bytes, ours[i].Bytes);
        }

        // directories come before what is in them (opkg extracts in order)
        var names = ReadTarGz(ReadAr(Ours())[2].Bytes).Select(e => e.Name).ToList();
        foreach (var n in names)
        {
            var parent = n.TrimEnd('/');
            parent = parent.Contains('/') ? parent[..(parent.LastIndexOf('/') + 1)] : null!;
            if (parent is not null)
            {
                Assert.True(names.IndexOf(parent) < names.IndexOf(n), $"{parent} before {n}");
            }
        }
    }

    [Fact]
    public void HeadersAreValidUstar()
    {
        foreach (var e in ReadTarGz(ReadAr(Ours())[2].Bytes))
        {
            var h = (byte[])e.Header.Clone();
            var stored = Convert.ToInt32(Encoding.ASCII.GetString(h, 148, 8).Trim(' ', '\0'), 8);
            for (var i = 148; i < 156; i++)
            {
                h[i] = (byte)' ';
            }

            Assert.Equal(stored, h.Sum(b => b));
        }
    }

    [Fact]
    public void ShellPackageCarriesTheStampedConfig()
    {
        var ipk = ShellIpk.Build("http://192.0.2.10:8096", "", "0123456789abcdef", DateTimeOffset.UnixEpoch.AddYears(56));
        var data = ReadTarGz(ReadAr(ipk)[2].Bytes);
        var config = Encoding.UTF8.GetString(data.Single(e => e.Name.EndsWith("/config.js", StringComparison.Ordinal)).Bytes);
        Assert.Equal("window.TALLY_SHELL_CONFIG = {\n  \"platform\": \"webos\",\n  \"server\": \"http://192.0.2.10:8096\",\n  \"bundle\": \"\",\n  \"devModeToken\": \"0123456789abcdef\"\n};\n", config);
        var appinfo = Encoding.UTF8.GetString(data.Single(e => e.Name.EndsWith("/appinfo.json", StringComparison.Ordinal)).Bytes);
        Assert.Contains("\"version\": \"" + ShellIpk.Version + "\"", appinfo);
        Assert.Contains("\"disableBackHistoryAPI\": true", appinfo);
        var index = Encoding.UTF8.GetString(data.Single(e => e.Name.EndsWith("/index.html", StringComparison.Ordinal)).Bytes);
        Assert.DoesNotContain("PLATFORM", index);
        // without a token: exactly package-webos.sh's config.js
        Assert.Equal("window.TALLY_SHELL_CONFIG = {\n  \"platform\": \"webos\",\n  \"server\": \"http://192.0.2.10:8096\",\n  \"bundle\": \"\"\n};\n",
            Encoding.UTF8.GetString(ShellIpk.ConfigJs("http://192.0.2.10:8096")));
        Assert.Equal("io.github.scdouglas1999.tally_" + ShellIpk.Version + "_all.ipk", IpkWriter.FileName(ShellIpk.AppId, ShellIpk.Version));
    }

    [Theory]
    [InlineData("io.github.scdouglas1999.tally", true)]
    [InlineData("com.example.app-2", true)]
    [InlineData("Com.Example", false)]
    [InlineData(".hidden", false)]
    [InlineData("a b", false)]
    public void ChecksAppIds(string id, bool ok) => Assert.Equal(ok, IpkWriter.IsValidId(id));

    [Fact]
    public void Crc32IsZlibs() => Assert.Equal(0xCBF43926u, IpkWriter.Crc32("123456789"u8));
}
