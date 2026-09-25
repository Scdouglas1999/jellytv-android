using System.Text.Json;
using System.Text.Json.Nodes;

namespace Tally.LgInstaller.Webos;

/// <summary>
/// The TV's own services (the Luna bus), called over SSH with <c>luna-send-pub</c> exactly as LG's CLI does
/// (@webos-tools/cli 3.2.6: files/conf/command-service.json names the services, lib/base/luna.js runs
/// <c>/usr/bin/luna-send-pub -n 1 luna://&lt;service&gt;/&lt;folder&gt;/&lt;method&gt; '&lt;json&gt;'</c> or <c>-i</c>
/// for a subscription, one JSON object per line, <c>returnValue: false</c> = failed with <c>errorText</c>).
/// </summary>
public static class Luna
{
    public const string LunaSend = "/usr/bin/luna-send-pub";

    /// <summary>ares-install: <c>com.webos.appInstallService/dev/install</c>, subscribed, until details.state says.</summary>
    public const string Install = "luna://com.webos.appInstallService/dev/install";
    public const string Remove = "luna://com.webos.appInstallService/dev/remove";
    /// <summary>ares-launch.</summary>
    public const string Launch = "luna://com.webos.applicationManager/launch";
    public const string Close = "luna://com.webos.applicationManager/dev/closeByAppId";
    /// <summary>ares-install --list.</summary>
    public const string ListApps = "luna://com.webos.applicationManager/dev/listApps";
    /// <summary>ares-device --system-info: model name, webOS SDK version, firmware.</summary>
    public const string SystemInfo = "luna://com.webos.service.tv.systemproperty/getSystemInfo";

    /// <summary>The shell command: one reply (<paramref name="subscribe"/> false) or replies until the stream ends.</summary>
    public static string Command(string uri, JsonObject parameters, bool subscribe = false) =>
        LunaSend + (subscribe ? " -i " : " -n 1 ") + uri + " " + ShellQuote(parameters.ToJsonString());

    /// <summary>Single quotes for a POSIX shell (the TV runs the command through its shell).</summary>
    public static string ShellQuote(string s) => "'" + s.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    public static JsonObject InstallParams(string appId, string ipkPath) =>
        new() { ["id"] = appId, ["ipkUrl"] = ipkPath, ["subscribe"] = true };

    public static JsonObject RemoveParams(string appId) => new() { ["id"] = appId, ["subscribe"] = true };

    public static JsonObject LaunchParams(string appId) => new() { ["id"] = appId };

    public static JsonObject SystemInfoParams() =>
        new() { ["keys"] = new JsonArray("modelName", "sdkVersion", "firmwareVersion", "boardType", "otaId"), ["subscribe"] = false };

    /// <summary>Each complete JSON object in <paramref name="output"/> (luna-send prints one per line; long ones may wrap).</summary>
    public static IEnumerable<JsonObject> Replies(string output)
    {
        var pending = "";
        foreach (var line in output.Split('\n'))
        {
            pending += line.TrimEnd('\r');
            if (pending.Trim().Length == 0)
            {
                pending = "";
                continue;
            }

            JsonObject? obj = null;
            try
            {
                obj = JsonNode.Parse(pending) as JsonObject;
            }
            catch (JsonException)
            {
                // not complete yet
            }

            if (obj is not null)
            {
                pending = "";
                yield return obj;
            }
        }
    }

    public static bool Failed(JsonObject reply, out string error)
    {
        if (reply["returnValue"] is JsonValue v && v.TryGetValue<bool>(out var ok) && !ok)
        {
            error = (reply["errorText"] ?? reply["errorMessage"] ?? reply["errorCode"])?.ToString() ?? "failed";
            return true;
        }

        error = "";
        return false;
    }
}

public enum InstallState
{
    /// <summary>Still going ("installing", "download", …).</summary>
    Working,
    Installed,
    Failed,
}

/// <summary>What the install subscription said, as ares-install reads it (lib/install.js: details.state).</summary>
public sealed record InstallProgress(InstallState State, string Text, string? Error)
{
    /// <summary>
    /// One reply of <c>dev/install</c>: <c>details.state</c> "installed" is done; "install failed" (or a reply with
    /// returnValue false, or a details.errorCode) failed; anything else is progress.
    /// </summary>
    public static InstallProgress From(JsonObject reply)
    {
        if (Luna.Failed(reply, out var error))
        {
            return new InstallProgress(InstallState.Failed, error, error);
        }

        var details = reply["details"] as JsonObject;
        var state = details?["state"]?.ToString() ?? reply["statusValue"]?.ToString() ?? "";
        var reason = details?["reason"]?.ToString() ?? details?["errorCode"]?.ToString();
        if (state.Equals("installed", StringComparison.OrdinalIgnoreCase))
        {
            return new InstallProgress(InstallState.Installed, state, null);
        }

        if (state.Contains("fail", StringComparison.OrdinalIgnoreCase) || details?["errorCode"] is not null)
        {
            return new InstallProgress(InstallState.Failed, state, reason ?? state);
        }

        return new InstallProgress(InstallState.Working, state, null);
    }
}
