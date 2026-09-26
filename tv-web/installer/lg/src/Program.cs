using Tally.LgInstaller.Ipk;
using Tally.LgInstaller.Webos;

namespace Tally.LgInstaller;

/// <summary>
/// Tally-LG-Installer: see <see cref="LgOptions.Usage"/>. Every run also writes Tally-LG-Installer.log in the temp
/// folder (what was said, what the TV answered).
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        ConsoleHost.UseUtf8();

        LgOptions options;
        try
        {
            options = LgOptions.Parse(args);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        if (options.Help)
        {
            Console.WriteLine(LgOptions.Usage);
            return 0;
        }

        if (options.Licenses)
        {
            Console.WriteLine(System.Text.Encoding.UTF8.GetString(ShellIpk.Resource("NOTICE.txt")));
            return 0;
        }

        var store = new KeyStore(options.DataDir ?? KeyStore.DefaultDirectory);
        return await ConsoleHost.RunAsync("Tally for LG", "Tally-LG-Installer.log", "Tally-LG-Installer/1.0", args,
            (ui, http, ct) => new LgInstallerFlow(ui, options, http, store).RunAsync(ct),
            logPath => $"Log: {logPath}. TV keys: {store.Directory} (lets the next update skip the passphrase).",
            pause: !options.Yes).ConfigureAwait(false);
    }
}
