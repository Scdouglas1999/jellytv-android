using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Tally.LgInstaller.Ipk;

/// <summary>
/// The Tally TV shell for LG (the files scripts/package-webos.sh packs), carried inside the program, with the Jellyfin
/// address and the TV's Developer Mode session stamped into config.js at install time.
/// </summary>
public static class ShellIpk
{
    public const string AppId = "io.github.scdouglas1999.tally";

    /// <summary>The shell's version (tv-web/package.json), which is also the app's version on the TV.</summary>
    public static string Version
    {
        get
        {
            using var doc = JsonDocument.Parse(Resource("package.json"));
            return doc.RootElement.GetProperty("version").GetString() ?? "0.0.0";
        }
    }

    public static byte[] Resource(string name)
    {
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
                      ?? throw new InvalidOperationException("missing resource " + name);
        using var copy = new MemoryStream();
        s.CopyTo(copy);
        return copy.ToArray();
    }

    /// <summary>The app folder's files, as package-webos.sh stages them.</summary>
    public static SortedDictionary<string, byte[]> Files(string server, string bundle = "", string devModeToken = "")
    {
        byte[] Res(string name) => Resource("shell/" + name);
        string ResText(string name) => Encoding.UTF8.GetString(Res(name));
        return new SortedDictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["shell.js"] = Res("shell.js"),
            ["shell.css"] = Res("shell.css"),
            ["fonts/plex-mono-500.woff2"] = Res("fonts/plex-mono-500.woff2"),
            ["fonts/plex-sans.woff2"] = Res("fonts/plex-sans.woff2"),
            ["fonts/OFL.txt"] = Res("fonts/OFL.txt"),
            ["icon-80.png"] = Res("icon-80.png"),
            ["icon-130.png"] = Res("icon-130.png"),
            ["appinfo.json"] = Encoding.UTF8.GetBytes(ResText("appinfo.json").Replace("@VERSION@", Version, StringComparison.Ordinal)),
            // webOS needs no platform script in the page: Luna calls go through PalmServiceBridge
            ["index.html"] = Encoding.UTF8.GetBytes(Regex.Replace(ResText("index.html"), "<!-- PLATFORM:.*-->", "")),
            ["config.js"] = ConfigJs(server, bundle, devModeToken),
        };
    }

    /// <summary>config.js as package-webos.sh writes it, plus the Developer Mode session when the TV gave one.</summary>
    public static byte[] ConfigJs(string server, string bundle = "", string devModeToken = "")
    {
        var fields = new List<(string, string)> { ("platform", "webos"), ("server", server), ("bundle", bundle) };
        if (devModeToken.Length > 0)
        {
            fields.Add(("devModeToken", devModeToken));
        }

        return ShellConfig.Js(fields);
    }

    public static byte[] Build(string server, string bundle, string devModeToken, DateTimeOffset time) =>
        IpkWriter.Build(AppId, Version, Files(server, bundle, devModeToken), time);
}
