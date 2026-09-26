namespace Tally.Installer;

/// <summary>
/// The "Your Jellyfin server" step both installers share: asks for the address (unless it was given), checks it the
/// way the TV shell will use it, warns when the server's plugin has no TV app yet. Null when the person gave up (or,
/// with <paramref name="yes"/>, when the given address did not answer).
/// </summary>
public sealed class ServerStep(Ui ui, HttpClient http, bool yes)
{
    public async Task<string?> AskAsync(string? typed, CancellationToken ct)
    {
        var checker = new JellyfinServer(http);
        if (typed is null)
        {
            ui.Say("Type the address of the Jellyfin server Tally should use: the one you open Jellyfin with " +
                   "(for example https://jellyfin.example.com, or 192.168.1.10 for a server at home).");
        }

        while (true)
        {
            typed ??= ui.Ask("Server address:");
            if (typed.Length == 0)
            {
                if (yes)
                {
                    return null;
                }

                typed = null;
                continue;
            }

            ui.Progress($"Checking {typed}…");
            var (server, problems) = await checker.CheckAsync(typed, ct).ConfigureAwait(false);
            if (server is not null)
            {
                ui.Good($"Found {(server.Name.Length > 0 ? server.Name : "the server")} (Jellyfin {server.Version}) at {server.Address}.");
                if (!server.HasTvApp)
                {
                    ui.Problem("This server does not have Tally's TV app yet (its Tally plugin is missing or older). " +
                               "Tally will install, and the TV will say so until the server's owner installs or updates the Tally plugin.");
                    if (!(yes || ui.AskYesNo("Install anyway?", true)))
                    {
                        return null;
                    }
                }

                return server.Address;
            }

            ui.Problem($"No Jellyfin server answered at {typed}.");
            foreach (var p in problems)
            {
                ui.Detail("  " + p);
            }

            ui.Say("Check the address (it is the one you type in a browser to open Jellyfin, with :8096 or https:// if you use them) and that this PC can open it.");
            if (yes)
            {
                return null;
            }

            typed = null;
        }
    }
}

/// <summary>What the person does on the TV once Tally is on it: the Quick Connect sign-in, the same on every TV.</summary>
public static class Handoff
{
    public static void SignIn(Ui ui, string? server)
    {
        ui.Blank();
        ui.Say("On the TV, Tally shows a 6-digit code. To sign in:\n" +
               "  1. On your phone (or a computer), open Jellyfin" + (server is null ? "" : $" ({server})") + " and sign in.\n" +
               "  2. Open Settings (your profile picture) > Quick Connect.\n" +
               "  3. Type the code from the TV and press Authorize. The TV signs in by itself.");
        ui.Detail("Updates come from the server: when its Tally plugin is updated, the TV app is too. " +
                  "Run this program again only if Tally on the TV asks to be reinstalled.");
    }
}
