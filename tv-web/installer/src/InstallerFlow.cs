using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Tally.SamsungInstaller.Certificates;
using Tally.SamsungInstaller.Samsung;
using Tally.SamsungInstaller.Sdb;
using Tally.SamsungInstaller.Signing;
using Tally.SamsungInstaller.Tv;

namespace Tally.SamsungInstaller;

public sealed record Options
{
    /// <summary>The TV's address (skips the search).</summary>
    public string? Tv { get; init; }
    public int SdbPort { get; init; } = SdbClient.DefaultPort;
    /// <summary>The Jellyfin address (skips the question).</summary>
    public string? Server { get; init; }
    /// <summary>Install this .wgt as it is (made and signed elsewhere for this TV).</summary>
    public string? Wgt { get; init; }
    /// <summary>Answer every question with its default (for scripts and tests).</summary>
    public bool Yes { get; init; }
    public string? DataDir { get; init; }
    /// <summary>Make a Samsung-signed Tally.wgt for another TV (its DUID) instead of installing.</summary>
    public string? MakeForDuid { get; init; }
    /// <summary>Only write a Tally.wgt signed with this PC's Tizen certificate (no TV).</summary>
    public bool PackageOnly { get; init; }
    public string? Out { get; init; }
    public bool NoLaunch { get; init; }
    /// <summary>Sign with the Samsung certificate even on a TV that takes the Tizen one.</summary>
    public bool Samsung { get; init; }
    /// <summary>Try this PC's Tizen certificate even on a 2023+ TV (Tizen 7.0 sets may still take it).</summary>
    public bool Tizen { get; init; }
    public bool Help { get; init; }
    /// <summary>Development: the shell loads the app bundle from here instead of the server (package-tizen.sh --bundle).</summary>
    public string Bundle { get; init; } = "";
    public bool Licenses { get; init; }

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (var i = 0; i < args.Length; i++)
        {
            string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"{args[i]} needs a value");
            var a = args[i];
            o = a switch
            {
                "--tv" => o with { Tv = Next() },
                "--sdb-port" => o with { SdbPort = int.Parse(Next(), System.Globalization.CultureInfo.InvariantCulture) },
                "--server" => o with { Server = Next() },
                "--wgt" => o with { Wgt = Next() },
                "--yes" or "-y" => o with { Yes = true },
                "--data-dir" => o with { DataDir = Next() },
                "--make-wgt" => o with { MakeForDuid = Next() },
                "--package" => o with { PackageOnly = true },
                "--out" or "-o" => o with { Out = Next() },
                "--no-launch" => o with { NoLaunch = true },
                "--samsung" => o with { Samsung = true },
                "--tizen" => o with { Tizen = true },
                "--help" or "-h" or "/?" => o with { Help = true },
                "--licenses" => o with { Licenses = true },
                "--bundle" => o with { Bundle = Next() },
                // dropping a .wgt on the program (Windows) starts it with the file as its only argument
                _ when a.EndsWith(".wgt", StringComparison.OrdinalIgnoreCase) && File.Exists(a) => o with { Wgt = a },
                _ => throw new ArgumentException($"unknown option {a} (see --help)"),
            };
        }

        return o;
    }

    public const string Usage = """
        Tally for Samsung: installs Tally on a Samsung TV (2020 and newer) in Developer Mode.
        Run it without options and answer its questions. Options, for scripts and helpers:
          --tv <ip>             the TV's address (no search)
          --server <address>    the Jellyfin server's address (no question)
          --wgt <file>          install this Tally.wgt as it is (one someone made for this TV)
          --samsung             sign with a Samsung certificate even on a 2020-2022 TV
          --tizen               try this PC's Tizen certificate even on a 2023+ TV (some Tizen 7.0 sets take it;
                                if the TV refuses it, the installer offers the Samsung certificate)
          --make-wgt <DUID>     make a Tally.wgt for another person's TV with your Samsung account
                                (with --server and --out); they install it with --wgt
          --package             only write a Tally.wgt signed with this PC's Tizen certificate (with --server, --out)
          --out <file>          where --make-wgt / --package write the file
          --no-launch           do not start Tally after installing
          --yes                 take the default answer everywhere
          --data-dir <folder>   where the certificates are kept (default: the app-data folder, Tally/Samsung)
          --licenses            the licenses of what the program carries
        """;
}

/// <summary>The installer, step by step, in plain words.</summary>
public sealed class InstallerFlow(Ui ui, Options options, HttpClient http, CertificateStore store)
{
    public Func<DateTimeOffset> Clock { get; init; } = () => DateTimeOffset.UtcNow;
    public Action<string> OpenBrowser { get; init; } = OpenInBrowser;
    public int TvInfoPort { get; init; } = 8001;
    public Func<IReadOnlyList<(IPAddress Local, IReadOnlyList<IPAddress> Hosts)>> Networks { get; init; } = TvScanner.LocalNetworks;

    private const int Steps = 4;

    /// <summary>0 when Tally was installed (or the file written), 1 otherwise.</summary>
    public async Task<int> RunAsync(CancellationToken ct)
    {
        ui.Title("Tally for Samsung");
        if (options.MakeForDuid is { } duid)
        {
            return await MakeForAnotherTvAsync(duid, ct).ConfigureAwait(false);
        }

        if (options.PackageOnly)
        {
            return await PackageOnlyAsync(ct).ConfigureAwait(false);
        }

        ui.Say("This puts Tally on your Samsung TV. Before you start, Developer Mode must be on for this PC " +
               "(the guide INSTALL-SAMSUNG.md shows how). The TV and this PC must be on the same network.");

        // 1. the TV
        ui.Step(1, Steps, "Find your TV");
        var tv = await ConnectToTvAsync(ct).ConfigureAwait(false);
        if (tv is null)
        {
            return 1;
        }

        await using var sdb = tv.Sdb;

        // 2. what it is
        ui.Step(2, Steps, "Your TV");
        var year = TizenYear(tv.TizenMajor, tv.TizenVersion);
        ui.Good($"Connected. Tizen {(tv.TizenVersion.Length > 0 ? tv.TizenVersion : "(version not reported)")}{(year is null ? "" : $", a {year} TV")}.");
        if (tv.Duid.Length > 0)
        {
            ui.Detail($"This TV's DUID (its ID for certificates): {tv.Duid}");
        }

        if (tv.TizenMajor is > 0 and < 5 || tv.TizenVersion == "5.0")
        {
            ui.Problem($"Tally needs a 2020 or newer Samsung TV (Tizen 5.5 or newer); this TV has Tizen {tv.TizenVersion}.");
            return 1;
        }

        // a file someone made for this TV: nothing to sign, no server to ask
        if (options.Wgt is { } file)
        {
            ui.Step(3, Steps, "Your Tally file");
            var bytes = await ReadWgtAsync(file, tv, ct).ConfigureAwait(false);
            if (bytes is null)
            {
                return 1;
            }

            ui.Step(4, Steps, "Install");
            return await InstallAsync(tv, bytes, ct).ConfigureAwait(false) ? 0 : 1;
        }

        // 3. the server
        ui.Step(3, Steps, "Your Jellyfin server");
        var server = await AskServerAsync(ct).ConfigureAwait(false);
        if (server is null)
        {
            return 1;
        }

        // 4. sign and install
        ui.Step(4, Steps, "Install");
        var useSamsung = options.Samsung || (tv.NeedsSamsungCertificate && !options.Tizen);
        while (true)
        {
            byte[]? wgt;
            if (useSamsung)
            {
                wgt = await SamsungSignedAsync(tv, server, ct).ConfigureAwait(false);
            }
            else
            {
                if (!await LoadTizenMaterialAsync(ct).ConfigureAwait(false))
                {
                    return 1;
                }

                ui.Progress("Signing Tally with this PC's Tizen certificate…");
                wgt = ShellPackage.BuildSigned(server, store.TizenAuthor(Clock), store.TizenDistributor(), options.Bundle);
            }

            if (wgt is null)
            {
                return 1;
            }

            var result = await InstallCoreAsync(tv, wgt, ct).ConfigureAwait(false);
            if (result.Ok)
            {
                return await FinishAsync(tv, server, ct).ConfigureAwait(false);
            }

            if (result.Outcome == InstallOutcome.CertificateNotTrusted && !useSamsung)
            {
                ui.Problem("This TV does not accept the Tizen certificate 2020-2022 TVs take. It needs a Samsung certificate.");
                if (!Confirm("Get a Samsung certificate now (sign in with a Samsung account in your browser)?", true))
                {
                    return 1;
                }

                useSamsung = true;
                continue;
            }

            if (result.Outcome == InstallOutcome.AuthorMismatch && await OfferUninstallAsync(tv, ct).ConfigureAwait(false))
            {
                continue;
            }

            ExplainFailure(result, tv);
            return 1;
        }
    }

    // ---- step 1: find and connect ----

    private async Task<TvDevice?> ConnectToTvAsync(CancellationToken ct)
    {
        string? address = options.Tv;
        IReadOnlyList<TvFound> found = [];
        if (address is null)
        {
            (address, found) = await ChooseTvAsync(ct).ConfigureAwait(false);
            if (address is null)
            {
                return null;
            }
        }

        while (true)
        {
            ui.Progress($"Connecting to {address}…");
            try
            {
                var sdb = await SdbClient.ConnectAsync(address, options.SdbPort, ct: ct).ConfigureAwait(false);
                try
                {
                    return await TvDevice.OpenAsync(sdb, ct).ConfigureAwait(false);
                }
                catch
                {
                    await sdb.DisposeAsync().ConfigureAwait(false);
                    throw;
                }
            }
            catch (SdbConnectException ex)
            {
                var info = found.FirstOrDefault(f => f.Address.ToString() == address);
                if (info is null && IPAddress.TryParse(address, out var ip))
                {
                    info = await new TvScanner(http) { SdbPort = options.SdbPort, InfoPort = TvInfoPort }.ProbeAsync(ip, ct).ConfigureAwait(false);
                }

                ExplainConnectFailure(address, ex.Failure, info);
            }
            catch (SdbException ex)
            {
                ui.Problem($"The TV stopped answering ({ex.Message}). Check it is still on, then try again.");
            }

            if (options.Yes)
            {
                return null;
            }

            var again = ui.Ask("Fix it on the TV, then press Enter to try again (or type another IP address, or q to quit):");
            if (again.Equals("q", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            if (again.Length > 0)
            {
                address = again;
            }
        }
    }

    private async Task<(string? Address, IReadOnlyList<TvFound> Found)> ChooseTvAsync(CancellationToken ct)
    {
        var networks = Networks();
        if (networks.Count > 0)
        {
            ui.Say($"This PC's address (what Developer Mode's \"Host PC IP\" must be): {string.Join(" or ", networks.Select(n => n.Local))}");
        }
        else
        {
            ui.Problem("This PC does not seem to be on a home network (no local network address found). Connect it to the same network as the TV.");
        }

        while (true)
        {
            IReadOnlyList<TvFound> found = [];
            if (networks.Count > 0)
            {
                ui.Progress("Looking for Samsung TVs on this network…");
                var scanner = new TvScanner(http) { SdbPort = options.SdbPort, InfoPort = TvInfoPort };
                found = await scanner.ScanAsync(networks.SelectMany(n => n.Hosts).Distinct(), ct).ConfigureAwait(false);
            }

            var candidates = found.Where(f => f.SdbPortOpen || f.DeveloperMode is not null || f.Name is not null).ToList();
            var ready = candidates.Where(c => c.SdbPortOpen).ToList();
            if (candidates.Count == 0)
            {
                ui.Say("No Samsung TV answered. That is normal while the TV is off or Developer Mode is not on yet " +
                       "(INSTALL-SAMSUNG.md, step 2). You can also type the TV's IP address (on the TV: Settings > General > " +
                       "Network > Network Status > IP Settings).");
            }
            else
            {
                ui.Say(candidates.Count == 1 ? "Found this TV:" : "Found these TVs:");
                for (var i = 0; i < candidates.Count; i++)
                {
                    var tv = candidates[i];
                    ui.Say($"  {i + 1}  {tv.Label}, {tv.Address}");
                    ui.Detail("       " + DeveloperModeLine(tv));
                }
            }

            if (options.Yes)
            {
                if (ready.Count == 0)
                {
                    ui.Problem("No TV with Developer Mode on was found.");
                }

                return (ready.FirstOrDefault()?.Address.ToString(), found);
            }

            var prompt = candidates.Count switch
            {
                0 => "Press Enter to look again, or type the TV's IP address (for example 192.168.1.40):",
                1 when ready.Count == 1 => "Press Enter to use it, or type another IP address:",
                1 => "Fix Developer Mode on the TV, then press Enter to look again (or type 1 to try this TV anyway):",
                _ => $"Type the number of your TV (1-{candidates.Count}) or its IP address, or press Enter to look again:",
            };
            while (true)
            {
                var answer = ui.Ask(prompt);
                if (answer.Length == 0)
                {
                    if (candidates.Count == 1 && ready.Count == 1)
                    {
                        return (candidates[0].Address.ToString(), found);
                    }

                    break; // look again
                }

                if (int.TryParse(answer, out var n) && n >= 1 && n <= candidates.Count)
                {
                    return (candidates[n - 1].Address.ToString(), found);
                }

                if (IPAddress.TryParse(answer, out var ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    return (ip.ToString(), found);
                }

                if (answer.Equals("q", StringComparison.OrdinalIgnoreCase))
                {
                    return (null, found);
                }

                ui.Problem("That is not one of the numbers or an IP address like 192.168.1.40.");
            }
        }
    }

    private static string DeveloperModeLine(TvFound tv)
    {
        var here = TvScanner.LocalAddressFor(tv.Address)?.ToString();
        return (tv.DeveloperMode, tv.DeveloperIp, tv.SdbPortOpen) switch
        {
            (false, _, _) => "Developer Mode is off",
            (true, { } ip, _) when here is not null && ip != here && ip != "0.0.0.0" =>
                $"Developer Mode is on, but for another computer ({ip}; this PC is {here})",
            (true, _, true) => "Developer Mode is on, ready",
            (true, _, false) => "Developer Mode is on (restart the TV if you just switched it on)",
            (null, _, true) => "Developer Mode's port answers",
            _ => "Developer Mode: not known",
        };
    }

    private void ExplainConnectFailure(string address, SdbConnectFailure failure, TvFound? info)
    {
        var here = IPAddress.TryParse(address, out var ip) ? TvScanner.LocalAddressFor(ip)?.ToString() ?? "this PC's address" : "this PC's address";
        var howTo =
            "How to fix it, on the TV:\n" +
            "  1. Open Apps (the Apps panel from the Home screen).\n" +
            "  2. With the remote, type 1 2 3 4 5 (on some TVs: open App Settings first, then type it).\n" +
            "  3. Switch Developer mode On, enter " + here + " as Host PC IP, and press OK.\n" +
            "  4. Restart the TV fully: hold the remote's power button until the TV turns off and on again\n" +
            "     (or unplug it for 30 seconds).";
        if (info?.DeveloperMode == false)
        {
            ui.Problem($"The TV at {address} has Developer Mode off.");
        }
        else if (info?.DeveloperIp is { } devIp && devIp != "0.0.0.0" && devIp != here)
        {
            ui.Problem($"Developer Mode on this TV is set for another computer ({devIp}), not this PC ({here}).");
        }
        else
        {
            ui.Problem(failure switch
            {
                SdbConnectFailure.NoAnswer =>
                    $"Nothing answered at {address}. The TV may be off or asleep, the address may be wrong, or Developer Mode is not on (or the TV was not restarted after switching it on).",
                SdbConnectFailure.WantsKey => "The TV asked for a key this installer does not have. Restart the TV and try again.",
                SdbConnectFailure.NotSdb => $"Something at {address} answered, but it is not a Samsung TV in Developer Mode.",
                _ => $"Your TV is not in Developer Mode, or the IP in Developer Mode is not this PC's ({here}). " +
                     "(Or Tizen Studio's sdb is connected to the TV from this PC: the TV takes one connection at a time. Close Tizen Studio.)",
            });
        }

        ui.Say(howTo);
    }

    // ---- step 3: the server ----

    private Task<string?> AskServerAsync(CancellationToken ct) => new ServerStep(ui, http, options.Yes).AskAsync(options.Server, ct);

    // ---- step 4: install ----

    private async Task<bool> InstallAsync(TvDevice tv, byte[] wgt, CancellationToken ct)
    {
        var result = await InstallCoreAsync(tv, wgt, ct).ConfigureAwait(false);
        if (result.Ok)
        {
            return await FinishAsync(tv, null, ct).ConfigureAwait(false) == 0;
        }

        if (result.Outcome == InstallOutcome.AuthorMismatch && await OfferUninstallAsync(tv, ct).ConfigureAwait(false))
        {
            return await InstallAsync(tv, wgt, ct).ConfigureAwait(false);
        }

        ExplainFailure(result, tv);
        return false;
    }

    private async Task<InstallResult> InstallCoreAsync(TvDevice tv, byte[] wgt, CancellationToken ct)
    {
        ui.Progress($"Copying Tally to the TV ({wgt.Length / 1024} KB) and installing…");
        var result = await tv.InstallAsync(wgt, line => ui.Detail("  TV: " + line), ct).ConfigureAwait(false);
        return result;
    }

    private async Task<int> FinishAsync(TvDevice tv, string? server, CancellationToken ct)
    {
        ui.Good("Tally is installed. From now on it is in the TV's Apps list.");
        if (!options.NoLaunch)
        {
            ui.Progress("Starting Tally on the TV…");
            if (!await tv.LaunchAsync(ct).ConfigureAwait(false))
            {
                ui.Say("Tally did not start by itself: open it from Apps on the TV.");
            }
        }

        Handoff.SignIn(ui, server);
        return 0;
    }

    private async Task<bool> OfferUninstallAsync(TvDevice tv, CancellationToken ct)
    {
        ui.Problem("Tally is already on this TV, installed from another computer or with another certificate, so the TV will not replace it.");
        ui.Say("It can be removed and installed again. Tally on the TV then forgets its sign-in and its settings (you sign in again with a code).");
        if (!Confirm("Remove the old Tally from the TV and install this one?", false))
        {
            return false;
        }

        ui.Progress("Removing the old Tally…");
        var log = await tv.UninstallAsync(ct).ConfigureAwait(false);
        foreach (var line in log.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0))
        {
            ui.Detail("  TV: " + line);
        }

        return true;
    }

    private void ExplainFailure(InstallResult result, TvDevice tv)
    {
        ui.Problem(result.Outcome switch
        {
            InstallOutcome.CertificateNotTrusted => "The TV did not accept the package's certificate." +
                (tv.NeedsSamsungCertificate ? " This TV needs a package signed with a Samsung certificate for its DUID (" + tv.Duid + ")." : ""),
            InstallOutcome.WrongTv => $"This Tally.wgt was made for another TV. Whoever made it needs this TV's DUID: {tv.Duid}.",
            InstallOutcome.NotYetValid => "The TV's clock is behind the certificate's start time. Set the TV's date and time (Settings > General > System Manager > Time), or wait a day, and try again.",
            InstallOutcome.Expired => "The certificate has expired. For a Samsung certificate, run this program again: it asks Samsung for a new one. For a file someone made, ask them for a new one.",
            InstallOutcome.TizenTooOld => "This TV's software is too old for Tally (it needs Tizen 5.5, 2020 TVs, or newer). Update the TV's software (Settings > Support > Software Update) and try again.",
            InstallOutcome.AuthorMismatch => "Tally stays as it was on the TV.",
            _ => "The TV could not install Tally." + (result.Reason is { Length: > 0 } r ? " It said: " + r : ""),
        });
        ui.Detail("The TV's full answer is in the log file (see below).");
    }

    // ---- Samsung certificates ----

    private async Task<byte[]?> SamsungSignedAsync(TvDevice tv, string server, CancellationToken ct)
    {
        if (tv.Duid.Length == 0)
        {
            ui.Problem("The TV did not tell its DUID, which a Samsung certificate needs. Restart the TV and try again.");
            return null;
        }

        if (store.SamsungFor(tv.Duid, Clock()) is not { } identities)
        {
            ui.Say($"This TV (Tizen {tv.TizenVersion}) only installs apps signed with a Samsung certificate made for it. " +
                   "There are two ways to get one:\n" +
                   "  1  Sign in with a Samsung account now (free; your browser opens Samsung's sign-in page).\n" +
                   "  2  Use a Tally.wgt someone made for this TV. Send them this TV's DUID: " + tv.Duid);
            var choice = options.Yes ? "1" : ui.Ask("Type 1 or 2:");
            // anything else asks again: a stray key must not open a browser to Samsung's sign-in
            while (choice != "1" && choice != "2")
            {
                choice = ui.Ask("Type 1 (Samsung account) or 2 (a Tally.wgt file), then press Enter:");
            }

            if (choice == "2")
            {
                var path = ui.Ask("Drag the Tally.wgt file into this window (or type its path), then press Enter:").Trim('"', '\'', ' ');
                return await ReadWgtAsync(path, tv, ct).ConfigureAwait(false);
            }

            if (await GetSamsungCertificatesAsync([tv.Duid], ct).ConfigureAwait(false) is not { } issued)
            {
                return null;
            }

            identities = issued;
        }
        else
        {
            ui.Progress("Using this PC's Samsung certificate for this TV.");
        }

        ui.Progress("Signing Tally with the Samsung certificate…");
        return ShellPackage.BuildSigned(server, identities.Author, identities.Distributor, options.Bundle);
    }

    /// <summary>Samsung sign-in, then author (kept key) and distributor certificates for the TVs.</summary>
    private async Task<(SigningIdentity Author, SigningIdentity Distributor)?> GetSamsungCertificatesAsync(
        IReadOnlyList<string> duids, CancellationToken ct)
    {
        ui.Say("Your browser opens Samsung's sign-in page. Sign in (or create a free Samsung account there), then come back to this window.");
        if (!options.Yes)
        {
            ui.Ask("Press Enter to open the browser:");
        }

        SamsungToken token;
        try
        {
            token = await SamsungLogin.SignInAsync(url =>
            {
                ui.Detail("If no browser opens, copy this address into one: " + url);
                OpenBrowser(url);
            }, TimeSpan.FromMinutes(10), ct).ConfigureAwait(false);
        }
        catch (SamsungException ex)
        {
            ui.Problem(ex.Message);
            return null;
        }

        ui.Good($"Signed in{(token.Email is { Length: > 0 } e ? " as " + e : "")}.");
        var service = new SamsungCertificateService(http);
        var cas = CertificateTools.SamsungCaCertificates();
        try
        {
            var now = Clock();
            var authorKey = store.SamsungAuthorKey();
            SigningIdentity author;
            if (store.SamsungAuthor is { } existing && existing.Certificate.NotAfter > now.UtcDateTime.AddDays(7)
                && existing.Certificate.GetRSAPublicKey()!.ExportSubjectPublicKeyInfo().AsSpan()
                    .SequenceEqual(authorKey.ExportSubjectPublicKeyInfo()))
            {
                author = existing;
            }
            else
            {
                ui.Progress("Asking Samsung for an author certificate…");
                var csr = CertificateTools.CreateCsrPem(authorKey, new X500DistinguishedName("CN=Tally"));
                var cert = await service.RequestAuthorAsync(token, csr, ct).ConfigureAwait(false);
                var ca = CertificateTools.FindIssuer(cert, cas)
                    ?? throw new SamsungException($"Samsung's author certificate comes from an unknown CA ({cert.Issuer}); this program needs an update.");
                store.SaveSamsungAuthor(authorKey, cert, ca);
                author = store.SamsungAuthor!;
            }

            var allDuids = store.SamsungDuids().Concat(duids).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            ui.Progress($"Asking Samsung for a distributor certificate for {(allDuids.Count == 1 ? "this TV" : allDuids.Count + " TVs")}…");
            using var distributorKey = RSA.Create(2048);
            var subject = new X500DistinguishedNameBuilder();
            if (token.Email is { Length: > 0 } email)
            {
                subject.AddEmailAddress(email);
            }

            subject.AddCommonName("TizenSDK");
            var dcsr = CertificateTools.CreateCsrPem(distributorKey, subject.Build(), allDuids);
            var dcert = await service.RequestDistributorAsync(token, dcsr, ct).ConfigureAwait(false);
            var dca = CertificateTools.FindIssuer(dcert, cas)
                ?? throw new SamsungException($"Samsung's distributor certificate comes from an unknown CA ({dcert.Issuer}); this program needs an update.");
            store.SaveSamsungDistributor(distributorKey, dcert, dca);
            ui.Good($"Samsung certificates saved (valid until {dcert.NotAfter:MMMM d, yyyy}).");
            return (author, store.SamsungDistributor!);
        }
        catch (SamsungServiceException ex)
        {
            ui.Problem(ex.Message);
            return null;
        }
        catch (SamsungException ex)
        {
            ui.Problem(ex.Message);
            return null;
        }
    }

    private async Task<int> MakeForAnotherTvAsync(string duid, CancellationToken ct)
    {
        duid = duid.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(duid, "^[A-Za-z0-9]{10,64}$"))
        {
            ui.Problem($"\"{duid}\" is not a TV's DUID (10 or more letters and digits, as this program shows it for the TV).");
            return 1;
        }

        ui.Say($"This makes a Tally.wgt for another person's TV (DUID {duid}), signed with your Samsung account. " +
               "They install it with this program (it asks for the file, or: --wgt Tally.wgt).");
        var server = await AskServerAsync(ct).ConfigureAwait(false);
        if (server is null)
        {
            return 1;
        }

        var identities = store.SamsungFor(duid, Clock()) ?? await GetSamsungCertificatesAsync([duid], ct).ConfigureAwait(false);
        if (identities is not { } id)
        {
            return 1;
        }

        var wgt = ShellPackage.BuildSigned(server, id.Author, id.Distributor, options.Bundle);
        var output = options.Out ?? Path.Combine(Environment.CurrentDirectory, "Tally.wgt");
        await File.WriteAllBytesAsync(output, wgt, ct).ConfigureAwait(false);
        ui.Good($"Wrote {output}. Send it to the TV's owner; it works only on the TV with DUID {duid}" +
                $", until {id.Distributor.Certificate.NotAfter:MMMM d, yyyy}.");
        return 0;
    }

    private async Task<int> PackageOnlyAsync(CancellationToken ct)
    {
        var server = await AskServerAsync(ct).ConfigureAwait(false);
        if (server is null)
        {
            return 1;
        }

        if (!await LoadTizenMaterialAsync(ct).ConfigureAwait(false))
        {
            return 1;
        }

        var wgt = ShellPackage.BuildSigned(server, store.TizenAuthor(Clock), store.TizenDistributor(), options.Bundle);
        var output = options.Out ?? Path.Combine(Environment.CurrentDirectory, "Tally.wgt");
        await File.WriteAllBytesAsync(output, wgt, ct).ConfigureAwait(false);
        ui.Good($"Wrote {output} (signed with this PC's Tizen certificate: for 2020-2022 TVs).");
        return 0;
    }

    /// <summary>
    /// Tizen's public signing material (downloaded once from download.tizen.org, then saved); false after telling the
    /// person why it could not be had.
    /// </summary>
    private async Task<bool> LoadTizenMaterialAsync(CancellationToken ct)
    {
        try
        {
            await store.LoadTizenDefaultsAsync(http, ui.Progress, ct).ConfigureAwait(false);
            return true;
        }
        catch (TizenSdkDownloadException ex)
        {
            ui.Problem(ex.Message);
            return false;
        }
    }

    /// <summary>A .wgt from disk, checked: a Tally package, signed, and (for a Samsung signature) listing this TV.</summary>
    private async Task<byte[]?> ReadWgtAsync(string path, TvDevice tv, CancellationToken ct)
    {
        byte[] bytes;
        try
        {
            bytes = await File.ReadAllBytesAsync(path, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            ui.Problem($"Could not read {path}: {ex.Message}");
            return null;
        }

        var check = WgtCheck.Inspect(bytes, tv.Duid);
        if (check.Problem is { } problem)
        {
            ui.Problem(problem);
            return null;
        }

        ui.Good(check.Summary);
        return bytes;
    }

    private bool Confirm(string question, bool defaultYes) => options.Yes ? defaultYes : ui.AskYesNo(question, defaultYes);

    /// <summary>The model year a Tizen version shipped on (5.5 → 2020 … 10.0 → 2026).</summary>
    public static int? TizenYear(int major, string version) => version switch
    {
        "5.5" => 2020,
        "6.0" => 2021,
        "6.5" => 2022,
        "7.0" => 2023,
        "8.0" => 2024,
        "9.0" => 2025,
        "10.0" => 2026,
        _ => major >= 11 ? 2016 + major : null,
    };

    public static void OpenInBrowser(string url) => Browser.Open(url);
}

/// <summary>What a .wgt from someone else is: Tally or not, how it is signed, and for which TVs.</summary>
public sealed record WgtCheck(string Summary, string? Problem)
{
    public static WgtCheck Inspect(byte[] wgt, string duid)
    {
        SortedDictionary<string, byte[]> files;
        try
        {
            files = ShellPackage.Unzip(wgt);
        }
        catch (InvalidDataException)
        {
            return new WgtCheck("", "That file is not a TV app package (.wgt).");
        }

        if (!files.TryGetValue("config.xml", out var config)
            || !System.Text.Encoding.UTF8.GetString(config).Contains($"id=\"{ShellPackage.ApplicationId}\"", StringComparison.Ordinal))
        {
            return new WgtCheck("", "That file is not Tally for Samsung.");
        }

        if (!files.TryGetValue(WidgetSigner.DistributorSignatureFile, out var signature) || !files.ContainsKey(WidgetSigner.AuthorSignatureFile))
        {
            return new WgtCheck("", "That Tally.wgt is not signed; the TV would refuse it.");
        }

        var certs = System.Text.RegularExpressions.Regex.Matches(System.Text.Encoding.UTF8.GetString(signature),
                "<X509Certificate>([^<]*)</X509Certificate>")
            .Select(m => X509CertificateLoader.LoadCertificate(Convert.FromBase64String(m.Groups[1].Value.Replace("\n", "", StringComparison.Ordinal))))
            .ToList();
        var duids = certs.Count > 0 ? CertificateTools.DeviceIds(certs[0]) : [];
        if (duids.Count > 0 && duid.Length > 0 && !duids.Contains(duid, StringComparer.OrdinalIgnoreCase))
        {
            return new WgtCheck("", $"That Tally.wgt was made for another TV ({string.Join(", ", duids)}); this TV's DUID is {duid}. Ask for one made for {duid}.");
        }

        var server = files.TryGetValue("config.js", out var cfg)
            ? System.Text.RegularExpressions.Regex.Match(System.Text.Encoding.UTF8.GetString(cfg), "\"server\":\\s*\"([^\"]*)\"").Groups[1].Value
            : "";
        return new WgtCheck(
            "A Tally package" + (duids.Count > 0 ? " made for this TV" : "") + (server.Length > 0 ? $", for the server {server}" : "") + ".",
            null);
    }
}
