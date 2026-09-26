using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Tally.SamsungInstaller.Certificates;
using Tally.SamsungInstaller.Signing;

namespace Tally.SamsungInstaller.Tv;

/// <summary>
/// The Tally TV shell for Samsung (the files scripts/package-tizen.sh packs), carried inside the program, with the
/// Jellyfin address stamped into config.js at install time. Nothing about a server is in the program itself.
/// </summary>
public static class ShellPackage
{
    public const string PackageId = "TallyTVapp";
    public const string ApplicationId = "TallyTVapp.Tally";

    /// <summary>The shell's version (tv-web/package.json), which is also the widget version.</summary>
    public static string Version
    {
        get
        {
            using var doc = JsonDocument.Parse(CertificateTools.EmbeddedBytes(typeof(ShellPackage).Assembly, "package.json"));
            return doc.RootElement.GetProperty("version").GetString() ?? "0.0.0";
        }
    }

    /// <summary>The unsigned package files, as scripts/package-tizen.sh stages them.</summary>
    public static SortedDictionary<string, byte[]> Files(string server, string bundle = "")
    {
        var assembly = typeof(ShellPackage).Assembly;
        byte[] Res(string name) => CertificateTools.EmbeddedBytes(assembly, "shell/" + name);
        string ResText(string name) => Encoding.UTF8.GetString(Res(name));

        var files = new SortedDictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["shell.js"] = Res("shell.js"),
            ["shell.css"] = Res("shell.css"),
            ["fonts/plex-mono-500.woff2"] = Res("fonts/plex-mono-500.woff2"),
            ["fonts/plex-sans.woff2"] = Res("fonts/plex-sans.woff2"),
            ["fonts/OFL.txt"] = Res("fonts/OFL.txt"),
            ["icon.png"] = Res("icon.png"),
            ["config.xml"] = Encoding.UTF8.GetBytes(ResText("config.xml").Replace("@VERSION@", Version, StringComparison.Ordinal)),
            // AVPlay and the other Samsung product APIs come from webapis.js, which the TV provides at $WEBAPIS
            ["index.html"] = Encoding.UTF8.GetBytes(System.Text.RegularExpressions.Regex.Replace(ResText("index.html"),
                "<!-- PLATFORM:.*-->", "<script src=\"$$WEBAPIS/webapis/webapis.js\"></script>")),
            ["config.js"] = ConfigJs(server, bundle),
        };
        return files;
    }

    /// <summary>config.js as package-tizen.sh writes it (JSON.stringify(…, null, 2)).</summary>
    public static byte[] ConfigJs(string server, string bundle = "") =>
        ShellConfig.Js([("platform", "tizen"), ("server", server), ("bundle", bundle)]);

    /// <summary>Signs and zips: the .wgt the TV installs.</summary>
    public static byte[] BuildSigned(string server, SigningIdentity author, SigningIdentity distributor, string bundle = "")
    {
        var signed = WidgetSigner.Sign(Files(server, bundle), author, distributor);
        return Zip(signed);
    }

    /// <summary>A zip as tizen package writes one: deflated entries in path order, no directory entries.</summary>
    public static byte[] Zip(IReadOnlyDictionary<string, byte[]> files)
    {
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (path, bytes) in files.OrderBy(f => f.Key, StringComparer.Ordinal))
            {
                var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
                using var s = entry.Open();
                s.Write(bytes);
            }
        }

        return output.ToArray();
    }

    /// <summary>The files of a .wgt.</summary>
    public static SortedDictionary<string, byte[]> Unzip(byte[] wgt)
    {
        var files = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
        using var zip = new ZipArchive(new MemoryStream(wgt), ZipArchiveMode.Read);
        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/'))
            {
                continue;
            }

            using var s = entry.Open();
            using var copy = new MemoryStream();
            s.CopyTo(copy);
            files[entry.FullName] = copy.ToArray();
        }

        return files;
    }
}
