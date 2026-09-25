using System.Net;
using Tally.LgInstaller.Ipk;
using Tally.LgInstaller.Webos;

namespace Tally.LgInstaller;

public sealed record LgOptions
{
    /// <summary>The TV's address (skips the search).</summary>
    public string? Tv { get; init; }
    public int SshPort { get; init; } = 9922;
    public int KeyPort { get; init; } = DevModeKey.KeyServerPort;
    public string User { get; init; } = "prisoner";
    /// <summary>A key file to use instead of the key server's (the emulator's, or one fetched before).</summary>
    public string? KeyFile { get; init; }
    /// <summary>The Developer Mode app's passphrase (skips the question).</summary>
    public string? Passphrase { get; init; }
    /// <summary>The Jellyfin address (skips the question).</summary>
    public string? Server { get; init; }
    public bool Yes { get; init; }
    public string? DataDir { get; init; }
    /// <summary>Only write the .ipk (with --server, --out).</summary>
    public bool PackageOnly { get; init; }
    public string? Out { get; init; }
    public bool NoLaunch { get; init; }
    public bool Help { get; init; }
    public bool Licenses { get; init; }
    /// <summary>Development: the shell loads the app bundle from here instead of the server (package-webos.sh --bundle).</summary>
    public string Bundle { get; init; } = "";

    public static LgOptions Parse(string[] args)
    {
        var o = new LgOptions();
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{args[i]} needs a value");
            int Port() => int.Parse(Next(), System.Globalization.CultureInfo.InvariantCulture);
            o = args[i] switch
            {
                "--tv" => o with { Tv = Next() },
                "--ssh-port" => o with { SshPort = Port() },
                "--key-port" => o with { KeyPort = Port() },
                "--user" => o with { User = Next() },
                "--key" => o with { KeyFile = Next() },
                "--passphrase" => o with { Passphrase = Next() },
                "--server" => o with { Server = Next() },
                "--yes" or "-y" => o with { Yes = true },
                "--data-dir" => o with { DataDir = Next() },
                "--package" => o with { PackageOnly = true },
                "--out" or "-o" => o with { Out = Next() },
                "--no-launch" => o with { NoLaunch = true },
                "--help" or "-h" or "/?" => o with { Help = true },
                "--licenses" => o with { Licenses = true },
                "--bundle" => o with { Bundle = Next() },
                var a => throw new ArgumentException($"unknown option {a} (see --help)"),
            };
        }

        return o;
    }

    public const string Usage = """
        Tally for LG: installs Tally on an LG TV (webOS 5 and newer: 2020 and newer) in Developer Mode.
        Run it without options and answer its questions. Options, for scripts and helpers:
          --tv <ip>             the TV's address (no search)
          --passphrase <text>   the passphrase the Developer Mode app shows (no question)
          --server <address>    the Jellyfin server's address (no question)
          --package             only write the Tally .ipk (with --server, --out)
          --out <file>          where --package writes the file
          --no-launch           do not start Tally after installing
          --yes                 take the default answer everywhere
          --data-dir <folder>   where the TVs' keys are kept (default: the app-data folder, Tally/LG)
          --licenses            the licenses of what the program carries
        For LG's webOS TV emulator: --tv 127.0.0.1 --ssh-port 6622 --user developer --key <its webos_emul key>
        """;
}

/// <summary>Tally for LG, step by step, in plain words.</summary>
public sealed class LgInstallerFlow(Ui ui, LgOptions options, HttpClient http, KeyStore store)
{
    public delegate Task<ITvConnection> Connector(string host, int port, string user, string key, string? passphrase, CancellationToken ct);

    public Connector Connect { get; init; } = async (h, p, u, k, pass, ct) => await SshTvConnection.ConnectAsync(h, p, u, k, pass, ct).ConfigureAwait(false);
    public Func<IReadOnlyList<(IPAddress Local, IReadOnlyList<IPAddress> Hosts)>> Networks { get; init; } = NetworkScan.LocalNetworks;
    public Func<DateTimeOffset> Clock { get; init; } = () => DateTimeOffset.UtcNow;
    public int WebosPort { get; init; } = 3000;
    public TimeSpan SsdpTime { get; init; } = TimeSpan.FromSeconds(2);

    private const int Steps = 4;

    public async Task<int> RunAsync(CancellationToken ct)
    {
        ui.Title("Tally for LG");
        if (options.PackageOnly)
        {
            return await PackageOnlyAsync(ct).ConfigureAwait(false);
        }

        ui.Say("This puts Tally on your LG TV. Before you start, Developer Mode must be on, with Key Server on " +
               "(the guide INSTALL-LG.md shows how). The TV and this PC must be on the same network.");

        // 1. the TV
        ui.Step(1, Steps, "Find your TV");
        var address = options.Tv ?? await ChooseTvAsync(ct).ConfigureAwait(false);
        if (address is null)
        {
            return 1;
        }

        // 2. connect and look
        ui.Step(2, Steps, "Your TV");
        await using var connection = await ConnectAsync(address, ct).ConfigureAwait(false);
        if (connection is null)
        {
            return 1;
        }

        var tv = new WebosTv(connection);
        var info = await tv.SystemInfoAsync(ct).ConfigureAwait(false);
        ui.Good($"Connected. webOS {(info.WebosVersion > 0 ? info.WebosVersion.ToString(System.Globalization.CultureInfo.InvariantCulture) : "(version not reported)")}" +
                (info.ModelName.Length > 0 ? $", {info.ModelName}" : "") +
                (info.FirstYear is { } year ? $" (webOS of {year} TVs)" : "") + ".");
        if (info.WebosVersion is > 0 and < 5)
        {
            ui.Problem($"Tally needs a 2020 or newer LG TV (webOS 5 or newer); this TV has webOS {info.WebosVersion}.");
            return 1;
        }

        var token = await tv.SessionTokenAsync(ct).ConfigureAwait(false);
        if (token.Length == 0)
        {
            ui.Detail("This TV did not give its Developer Mode session, so the server cannot keep Developer Mode on by itself. " +
                      "Open the Developer Mode app on the TV now and then to extend it, or LG removes Tally when it runs out.");
        }

        // 3. the server
        ui.Step(3, Steps, "Your Jellyfin server");
        var server = await new ServerStep(ui, http, options.Yes).AskAsync(options.Server, ct).ConfigureAwait(false);
        if (server is null)
        {
            return 1;
        }

        // 4. install
        ui.Step(4, Steps, "Install");
        var ipk = ShellIpk.Build(server, options.Bundle, token, Clock());
        var file = IpkWriter.FileName(ShellIpk.AppId, ShellIpk.Version);
        ui.Progress($"Copying Tally to the TV ({ipk.Length / 1024} KB) and installing…");
        // an update replaces the files under a running Tally: close it first (nothing happens when it is not running)
        await tv.CloseAsync(ShellIpk.AppId, ct).ConfigureAwait(false);
        var result = await tv.InstallAsync(ipk, file, ShellIpk.AppId, state => ui.Detail("  TV: " + state), ct).ConfigureAwait(false);
        if (!result.Ok)
        {
            ui.Problem(result.Reason ?? "The TV could not install Tally.");
            ui.Detail("The TV's full answer is in the log file (see below).");
            return 1;
        }

        ui.Good("Tally is installed. From now on it is in the TV's apps list.");
        if (!options.NoLaunch)
        {
            ui.Progress("Starting Tally on the TV…");
            if (!await tv.LaunchAsync(ShellIpk.AppId, ct).ConfigureAwait(false))
            {
                ui.Say("Tally did not start by itself: open it from the TV's apps.");
            }
        }

        Handoff.SignIn(ui, server);
        if (token.Length > 0)
        {
            ui.Detail("Developer Mode stays on: once someone signs in on the TV, the server renews its session every day. " +
                      "The server's Tally settings page shows it (\"LG Developer Mode kept on for 1 TV\").");
        }

        return 0;
    }

    // ---- step 1: find the TV ----

    private async Task<string?> ChooseTvAsync(CancellationToken ct)
    {
        var networks = Networks();
        if (networks.Count == 0)
        {
            ui.Problem("This PC does not seem to be on a home network (no local network address found). Connect it to the same network as the TV.");
        }

        while (true)
        {
            IReadOnlyList<LgFound> found = [];
            if (networks.Count > 0)
            {
                ui.Progress("Looking for LG TVs on this network…");
                var scanner = new LgScanner { SshPort = options.SshPort, KeyPort = options.KeyPort, WebosPort = WebosPort, SsdpTime = SsdpTime };
                found = await scanner.ScanAsync(networks.SelectMany(n => n.Hosts).Distinct(), ct).ConfigureAwait(false);
            }

            var ready = found.Where(f => f.DeveloperMode).ToList();
            if (found.Count == 0)
            {
                ui.Say("No LG TV answered. That is normal while the TV is off or Developer Mode is not on yet " +
                       "(INSTALL-LG.md, step 2). You can also type the TV's IP address: the Developer Mode app shows it.");
            }
            else
            {
                ui.Say(found.Count == 1 ? "Found this TV:" : "Found these TVs:");
                for (var i = 0; i < found.Count; i++)
                {
                    ui.Say($"  {i + 1}  {found[i].Label}, {found[i].Address}");
                    ui.Detail("       " + found[i].Status);
                }
            }

            if (options.Yes)
            {
                if (ready.Count == 0)
                {
                    ui.Problem("No TV with Developer Mode on was found.");
                }

                return ready.FirstOrDefault()?.Address.ToString();
            }

            var prompt = found.Count switch
            {
                0 => "Press Enter to look again, or type the TV's IP address (for example 192.168.1.40):",
                1 when ready.Count == 1 => "Press Enter to use it, or type another IP address:",
                1 => "Fix Developer Mode on the TV, then press Enter to look again (or type 1 to try this TV anyway):",
                _ => $"Type the number of your TV (1-{found.Count}) or its IP address, or press Enter to look again:",
            };
            while (true)
            {
                var answer = ui.Ask(prompt);
                if (answer.Length == 0)
                {
                    if (found.Count == 1 && ready.Count == 1)
                    {
                        return found[0].Address.ToString();
                    }

                    break;
                }

                if (int.TryParse(answer, out var n) && n >= 1 && n <= found.Count)
                {
                    return found[n - 1].Address.ToString();
                }

                if (IPAddress.TryParse(answer, out var ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    return ip.ToString();
                }

                if (answer.Equals("q", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }

                ui.Problem("That is not one of the numbers or an IP address like 192.168.1.40.");
            }
        }
    }

    // ---- step 2: the key and the connection ----

    private const string DeveloperModeHowTo =
        "How to fix it, on the TV:\n" +
        "  1. Open the Developer Mode app (from the apps list; install it from the LG Content Store if it is not there).\n" +
        "  2. Sign in with your LG developer account.\n" +
        "  3. Switch Dev Mode Status on (the TV restarts), open the app again and switch Key Server on.";

    private async Task<ITvConnection?> ConnectAsync(string address, CancellationToken ct)
    {
        var saved = store.For(address);
        // a key kept from last time: no key server and no passphrase needed while Developer Mode was not set up anew
        if (options.KeyFile is null && saved is not null)
        {
            ui.Progress($"Connecting to {address} with this PC's key for it…");
            try
            {
                var unlocked = DevModeKey.Unlock(saved.Key, saved.Passphrase);
                var openSsh = unlocked.Contains("OPENSSH", StringComparison.Ordinal);
                return await Connect(address, options.SshPort, options.User, unlocked, openSsh ? saved.Passphrase : null, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is TvConnectException { Failure: ConnectFailure.KeyRefused } or DevModeKeyException)
            {
                ui.Detail("The TV has a new key since last time (Developer Mode was set up again): getting it from the TV.");
                store.Forget(address);
            }
            catch (TvConnectException ex)
            {
                ExplainConnectFailure(address, ex);
                return null;
            }
        }

        for (var attempt = 0; ; attempt++)
        {
            string key;
            string? passphrase = null;
            if (options.KeyFile is { } file)
            {
                key = await File.ReadAllTextAsync(file, ct).ConfigureAwait(false);
            }
            else
            {
                ui.Progress($"Getting the TV's key from its Key Server ({address}:{options.KeyPort})…");
                var fetched = await DevModeKey.FetchAsync(http, address, options.KeyPort, ct).ConfigureAwait(false);
                if (fetched is null)
                {
                    ui.Problem($"The TV's Key Server did not answer at {address}. Open the Developer Mode app on the TV and switch Key Server on.");
                    ui.Say(DeveloperModeHowTo);
                    if (options.Yes || ui.Ask("Press Enter to try again (or q to quit):").Equals("q", StringComparison.OrdinalIgnoreCase))
                    {
                        return null;
                    }

                    continue;
                }

                key = fetched;
            }

            // the key server's key is always locked with the passphrase; a key file (the emulator's) may not be
            var locked = key.Contains("ENCRYPTED", StringComparison.Ordinal)
                         || (options.KeyFile is null && key.Contains("OPENSSH", StringComparison.Ordinal));
            if (locked || options.Passphrase is not null)
            {
                var typed = options.Passphrase;
                if (typed is null)
                {
                    if (options.Yes)
                    {
                        ui.Problem("The TV's key needs the passphrase the Developer Mode app shows (--passphrase).");
                        return null;
                    }

                    typed = ui.Ask(attempt == 0
                        ? "Type the passphrase the Developer Mode app shows on the TV (6 letters and digits, like 78DB5E):"
                        : "Type the passphrase again, exactly as the Developer Mode app shows it:");
                }

                passphrase = DevModeKey.NormalizePassphrase(typed);
            }

            string unlocked;
            try
            {
                unlocked = DevModeKey.Unlock(key, passphrase ?? "");
            }
            catch (DevModeKeyException ex)
            {
                ui.Problem(ex.Message + " The passphrase is on the Developer Mode app's screen on the TV (capital letters and digits).");
                if (options.Yes || options.Passphrase is not null || attempt >= 4)
                {
                    return null;
                }

                continue;
            }

            ui.Progress($"Connecting to {address}…");
            try
            {
                var openSsh = unlocked.Contains("OPENSSH", StringComparison.Ordinal);
                var connection = await Connect(address, options.SshPort, options.User, unlocked, openSsh ? passphrase : null, ct).ConfigureAwait(false);
                if (options.KeyFile is null && passphrase is not null)
                {
                    store.Save(address, new SavedTv { Key = key, Passphrase = passphrase });
                }

                return connection;
            }
            catch (TvConnectException ex)
            {
                ExplainConnectFailure(address, ex);
                if (options.Yes || ui.Ask("Fix it on the TV, then press Enter to try again (or q to quit):").Equals("q", StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }
            }
        }
    }

    private void ExplainConnectFailure(string address, TvConnectException ex)
    {
        ui.Problem(ex.Failure switch
        {
            ConnectFailure.NoAnswer =>
                $"Nothing answered on Developer Mode's port at {address}. The TV may be off, the address may be wrong, or Developer Mode is not on " +
                "(or the TV has not restarted since it was switched on).",
            ConnectFailure.KeyRefused => "The TV did not accept its key. If Developer Mode was switched off and on again, switch Key Server on and try again.",
            _ => $"Something at {address} answered, but it is not an LG TV in Developer Mode.",
        });
        ui.Detail("  " + ex.Message);
        ui.Say(DeveloperModeHowTo);
    }

    private async Task<int> PackageOnlyAsync(CancellationToken ct)
    {
        var server = await new ServerStep(ui, http, options.Yes).AskAsync(options.Server, ct).ConfigureAwait(false);
        if (server is null)
        {
            return 1;
        }

        var ipk = ShellIpk.Build(server, options.Bundle, "", Clock());
        var output = options.Out ?? Path.Combine(Environment.CurrentDirectory, IpkWriter.FileName(ShellIpk.AppId, ShellIpk.Version));
        await File.WriteAllBytesAsync(output, ipk, ct).ConfigureAwait(false);
        ui.Good($"Wrote {output} (install it with LG's ares-install, or with this program without --package).");
        return 0;
    }
}
