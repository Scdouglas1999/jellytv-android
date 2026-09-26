using Tally.SamsungInstaller.Certificates;

namespace Tally.SamsungInstaller;

/// <summary>
/// Tally-Samsung-Installer: see <see cref="Options.Usage"/>. Every run also writes Tally-Samsung-Installer.log in the
/// temp folder (what was said, what the TV answered).
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        ConsoleHost.UseUtf8();

        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException)
        {
            Console.Error.WriteLine(ex.Message);
            return 2;
        }

        if (options.Help)
        {
            Console.WriteLine(Options.Usage);
            return 0;
        }

        if (options.Licenses)
        {
            Console.WriteLine(CertificateTools.EmbeddedText("certificates/NOTICE.txt"));
            Console.WriteLine(CertificateTools.EmbeddedText("certificates/LICENSE-Apache-2.0.txt"));
            return 0;
        }

        var store = new CertificateStore(options.DataDir ?? CertificateStore.DefaultDirectory);
        return await ConsoleHost.RunAsync("Tally for Samsung", "Tally-Samsung-Installer.log", "Tally-Samsung-Installer/1.0", args,
            (ui, http, ct) => new InstallerFlow(ui, options, http, store).RunAsync(ct),
            logPath => $"Log: {logPath}. Certificates: {store.Directory} (keep this folder: updates need it).",
            pause: !options.Yes).ConfigureAwait(false);
    }
}
