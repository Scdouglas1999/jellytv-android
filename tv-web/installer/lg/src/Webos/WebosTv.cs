using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Tally.LgInstaller.Webos;

public sealed record SystemInfo(string ModelName, string SdkVersion, string Firmware)
{
    /// <summary>The TV's own version: 5.x, 6.x, then 7.x for webOS 22 … 10.x for webOS 25.</summary>
    public int SdkMajor => int.TryParse(SdkVersion.Split('.')[0], out var m) ? m : 0;

    /// <summary>webOS as LG names it: 5, 6, 22, 23, 24, 25 (the TV counts 7 for 22).</summary>
    public int WebosVersion => SdkMajor >= 7 ? SdkMajor + 15 : SdkMajor;

    /// <summary>The model year a webOS version first shipped on (5 = 2020 … 25 = 2025); later webOS reaches older sets too.</summary>
    public int? FirstYear => WebosVersion switch
    {
        5 => 2020,
        6 => 2021,
        >= 22 and <= 40 => 2000 + WebosVersion,
        _ => null,
    };
}

public sealed record TvInstallResult(bool Ok, string? Reason, string Log);

/// <summary>
/// A connected LG TV in Developer Mode and the installer's steps on it, as LG's CLI takes them (@webos-tools/cli 3.2.6
/// lib/install.js, lib/launch.js, lib/device.js): the package copied to /media/developer/temp, checked, installed
/// through <c>com.webos.appInstallService/dev/install</c> (its replies followed until details.state says
/// "installed" or "…failed"), removed from temp, started with <c>com.webos.applicationManager/launch</c>.
/// </summary>
public sealed class WebosTv(ITvConnection connection)
{
    public const string TempDir = "/media/developer/temp";

    /// <summary>Where the TV keeps the Developer Mode session's token (webosbrew dev-manager-desktop devmode.rs).</summary>
    public const string SessionTokenFile = "/var/luna/preferences/devmode_enabled";

    public ITvConnection Connection { get; } = connection;

    public async Task<SystemInfo> SystemInfoAsync(CancellationToken ct)
    {
        var output = await Connection.RunAsync(Luna.Command(Luna.SystemInfo, Luna.SystemInfoParams()), null, ct).ConfigureAwait(false);
        var reply = Luna.Replies(output).FirstOrDefault() ?? new JsonObject();
        return new SystemInfo(reply["modelName"]?.ToString() ?? "", reply["sdkVersion"]?.ToString() ?? "", reply["firmwareVersion"]?.ToString() ?? "");
    }

    /// <summary>The Developer Mode session's token, or "" where the TV does not let it be read (the emulator).</summary>
    public async Task<string> SessionTokenAsync(CancellationToken ct)
    {
        var bytes = await Connection.ReadAsync(SessionTokenFile, ct).ConfigureAwait(false);
        var token = bytes is null ? "" : Encoding.UTF8.GetString(bytes).Trim();
        return Regex.IsMatch(token, "^[0-9A-Za-z]{8,512}$") ? token : "";
    }

    /// <summary>Copies, checks, installs; <paramref name="onProgress"/> sees the install's states.</summary>
    public async Task<TvInstallResult> InstallAsync(byte[] ipk, string fileName, string appId, Action<string>? onProgress, CancellationToken ct)
    {
        var path = TempDir + "/" + fileName;
        await Connection.RunAsync($"/usr/bin/test -d {TempDir} || /bin/mkdir -p {TempDir}", null, ct).ConfigureAwait(false);
        await Connection.UploadAsync(ipk, path, ct).ConfigureAwait(false);

        // as ares-install: the last 200 bytes' MD5 on both sides (a copy cut short fails here, not in the installer)
        var tail = ipk.AsSpan(Math.Max(0, ipk.Length - 200)).ToArray();
        var expected = Convert.ToHexStringLower(MD5.HashData(tail));
        var check = await Connection.RunAsync($"/usr/bin/tail -c 200 {Luna.ShellQuote(path)} | /usr/bin/md5sum", null, ct).ConfigureAwait(false);
        if (!check.Contains(expected, StringComparison.Ordinal))
        {
            return new TvInstallResult(false, "The copy on the TV is not complete (" + check.Trim() + "). The TV may be out of space.", check);
        }

        InstallProgress? last = null;
        var shown = "";
        var log = await Connection.RunAsync(Luna.Command(Luna.Install, Luna.InstallParams(appId, path), subscribe: true), line =>
        {
            foreach (var reply in Luna.Replies(line))
            {
                last = InstallProgress.From(reply);
                // the TV repeats a state several times (LG's webOS 5 emulator: "ipk verifying" three times): once is enough
                if (last.State == InstallState.Working && last.Text.Length > 0 && last.Text != shown)
                {
                    shown = last.Text;
                    onProgress?.Invoke(last.Text);
                }

                if (last.State != InstallState.Working)
                {
                    return true;
                }
            }

            return false;
        }, ct).ConfigureAwait(false);
        await Connection.RunAsync("/bin/rm -f " + Luna.ShellQuote(path), null, ct).ConfigureAwait(false);
        return last switch
        {
            { State: InstallState.Installed } => new TvInstallResult(true, null, log),
            { State: InstallState.Failed } f => new TvInstallResult(false, Explain(f.Error ?? f.Text, log), log),
            _ => new TvInstallResult(false, "The TV stopped answering during the install.", log),
        };
    }

    /// <summary>The TV's reason in plain words where it is a known one (LG CLI error-handler.js, dev-manager).</summary>
    public static string Explain(string reason, string log)
    {
        var r = reason.ToLowerInvariant();
        if (r.Contains("failed_ipkg_install", StringComparison.Ordinal) || log.Contains("\"errorCode\":-5", StringComparison.Ordinal))
        {
            return "The TV does not have enough free space. Remove an app you do not use and try again.";
        }

        if (r.Contains("privileged", StringComparison.Ordinal))
        {
            return "The TV refused the app's name (" + reason + ").";
        }

        if (r.Contains("extract", StringComparison.Ordinal) || r.Contains("parse control", StringComparison.Ordinal))
        {
            return "The TV could not read the package (" + reason + "). Run the installer again; if it happens again, send the log.";
        }

        if (r.Contains("duplicate command", StringComparison.Ordinal) || r.Contains("locked", StringComparison.Ordinal))
        {
            return "The TV is busy with another install. Wait a minute and try again.";
        }

        return "The TV could not install Tally. It said: " + reason;
    }

    /// <summary>Starts the app; false when the TV said it could not.</summary>
    public async Task<bool> LaunchAsync(string appId, CancellationToken ct)
    {
        var output = await Connection.RunAsync(Luna.Command(Luna.Launch, Luna.LaunchParams(appId)), null, ct).ConfigureAwait(false);
        var reply = Luna.Replies(output).FirstOrDefault();
        return reply is not null && !Luna.Failed(reply, out _);
    }

    /// <summary>Closes the app if it runs (an update replaces files under a running app).</summary>
    public async Task CloseAsync(string appId, CancellationToken ct) =>
        await Connection.RunAsync(Luna.Command(Luna.Close, new JsonObject { ["id"] = appId }), null, ct).ConfigureAwait(false);
}
