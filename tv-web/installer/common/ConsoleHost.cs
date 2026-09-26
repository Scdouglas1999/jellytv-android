using System.Text;

namespace Tally.Installer;

/// <summary>
/// The frame of an installer program: UTF-8 console, a log file in the temp folder (what was said, what the TV
/// answered), Ctrl+C, one HttpClient, the unexpected-error sentence, the closing line and "Press Enter to close" (a
/// window opened by a double-click would otherwise vanish with the result).
/// </summary>
public static class ConsoleHost
{
    public static void UseUtf8()
    {
        try
        {
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch (IOException)
        {
            // no console
        }
    }

    /// <param name="product">"Tally for Samsung": the log's header.</param>
    /// <param name="logName">"Tally-Samsung-Installer.log", in the temp folder.</param>
    /// <param name="userAgent">"Tally-Samsung-Installer/1.0".</param>
    /// <param name="closing">The last detail line (where the log and the kept files are).</param>
    /// <param name="pause">Ask for Enter before closing (not for --yes).</param>
    public static async Task<int> RunAsync(string product, string logName, string userAgent, string[] args,
        Func<Ui, HttpClient, CancellationToken, Task<int>> run, Func<string, string> closing, bool pause)
    {
        var logPath = Path.Combine(Path.GetTempPath(), logName);
        using var log = OpenLog(logPath);
        log?.WriteLine($"--- {product} {System.Reflection.Assembly.GetEntryAssembly()?.GetName().Version}, {DateTime.Now:yyyy-MM-dd HH:mm}, {Environment.OSVersion}, args: {string.Join(' ', args)}");
        var ui = Ui.ForConsole(log);

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        using var http = new HttpClient(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(6) })
        {
            Timeout = TimeSpan.FromSeconds(60),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        int code;
        try
        {
            code = await run(ui, http, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            ui.Problem("Stopped.");
            code = 1;
        }
        catch (Exception ex)
        {
            ui.Problem("Something went wrong that this program did not expect: " + ex.Message);
            log?.WriteLine(ex.ToString());
            code = 1;
        }

        ui.Blank();
        ui.Detail(closing(logPath));
        if (pause && !Console.IsInputRedirected)
        {
            try
            {
                ui.Ask("Press Enter to close.");
            }
            catch (OperationCanceledException)
            {
                // input already closed
            }
        }

        return code;
    }

    public static StreamWriter? OpenLog(string path)
    {
        try
        {
            return new StreamWriter(path, append: true) { AutoFlush = true };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
