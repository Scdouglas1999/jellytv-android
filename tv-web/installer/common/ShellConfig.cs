using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Tally.Installer;

/// <summary>
/// config.js of the TV shell (tv-web/shell/config.js), as the package scripts write it with
/// <c>JSON.stringify(…, null, 2)</c>: the platform, the Jellyfin address stamped in, the development bundle address
/// and, on LG, the Developer Mode session token. Nothing about a server is in the programs themselves.
/// </summary>
public static class ShellConfig
{
    public static byte[] Js(IEnumerable<(string Key, string Value)> fields)
    {
        var json = new StringBuilder("{");
        var first = true;
        foreach (var (key, value) in fields)
        {
            json.Append(first ? "\n  " : ",\n  ").Append(JsonString(key)).Append(": ").Append(JsonString(value));
            first = false;
        }

        json.Append("\n}");
        return Encoding.UTF8.GetBytes("window.TALLY_SHELL_CONFIG = " + json + ";\n");
    }

    /// <summary>A JSON string literal as JSON.stringify writes it (and safe inside a script).</summary>
    public static string JsonString(string value)
    {
        var sb = new StringBuilder("\"");
        foreach (var c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        return sb.Append('"').ToString();
    }
}

/// <summary>Opens an address in the person's browser (Samsung's sign-in page, a guide); the address is also printed.</summary>
public static class Browser
{
    public static void Open(string url)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            else if (OperatingSystem.IsMacOS())
            {
                Process.Start("open", url);
            }
            else
            {
                Process.Start("xdg-open", url);
            }
        }
        catch (Exception)
        {
            // the address is printed as well
        }
    }
}
