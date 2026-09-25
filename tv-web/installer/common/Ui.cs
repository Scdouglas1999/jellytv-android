namespace Tally.Installer;

/// <summary>
/// The console the person sees: plain sentences, numbered steps, one question at a time, the amber of Tally for
/// headings where the console has color. ASCII marks only (OK, !!, >): the Windows 10 console font has no check
/// marks. Reads and writes go through here so tests can drive the flow.
/// </summary>
public sealed class Ui(TextReader input, TextWriter output, bool color)
{
    private const string Amber = "\u001b[38;5;214m";
    private const string Muted = "\u001b[38;5;246m";
    private const string Red = "\u001b[38;5;203m";
    private const string Reset = "\u001b[0m";

    public TextWriter Output { get; } = output;

    /// <summary>A copy of everything written (for the log file).</summary>
    public TextWriter? Log { get; init; }

    public static Ui ForConsole(TextWriter? log = null)
    {
        var color = !Console.IsOutputRedirected && Environment.GetEnvironmentVariable("NO_COLOR") is null;
        if (color && OperatingSystem.IsWindows())
        {
            color = WindowsConsole.EnableColors();
        }

        return new Ui(Console.In, Console.Out, color) { Log = log };
    }

    public void Title(string text)
    {
        Output.WriteLine();
        Write(Paint(Amber, "| " + text.ToUpperInvariant()));
        Output.WriteLine();
    }

    public void Step(int number, int total, string text)
    {
        Output.WriteLine();
        Write(Paint(Amber, $"STEP {number} OF {total}  ") + text.ToUpperInvariant());
    }

    public void Say(string text) => Write(Wrap(text, "  "));

    public void Detail(string text) => Write(Paint(Muted, Wrap(text, "  ")));

    public void Good(string text) => Write(Paint(Amber, Mark("OK", text)));

    public void Problem(string text) => Write(Paint(Red, Mark("!!", text)));

    /// <summary>"  OK  text", continuation lines under the text.</summary>
    private static string Mark(string mark, string text) => "  " + mark.PadRight(4) + Wrap(text, "      ")[6..];

    public void Blank() => Write("");

    /// <summary>Asks and returns the trimmed answer; the run stops when the input has ended.</summary>
    public string Ask(string question)
    {
        Output.Write("  " + Paint(Amber, "> ") + question + " ");
        Output.Flush();
        var answer = input.ReadLine();
        Log?.WriteLine("  > " + question + " " + answer);
        if (answer is null)
        {
            // the window's input closed (or a script ran out of answers): stop instead of asking forever
            Output.WriteLine();
            throw new OperationCanceledException("no more input");
        }

        return answer.Trim();
    }

    public bool AskYesNo(string question, bool defaultYes)
    {
        while (true)
        {
            var a = Ask(question + (defaultYes ? " [Y/n]" : " [y/N]")).ToLowerInvariant();
            if (a.Length == 0)
            {
                return defaultYes;
            }

            if (a is "y" or "yes")
            {
                return true;
            }

            if (a is "n" or "no")
            {
                return false;
            }
        }
    }

    public void Progress(string text)
    {
        Write(Paint(Muted, "  " + text));
    }

    private void Write(string text)
    {
        Output.WriteLine(text);
        Log?.WriteLine(StripColor(text));
    }

    private string Paint(string code, string text) => color ? code + text + Reset : text;

    private static string StripColor(string text) =>
        System.Text.RegularExpressions.Regex.Replace(text, "\u001b\\[[0-9;]*m", "");

    /// <summary>Wraps words at <paramref name="width"/> columns; a paragraph's own leading spaces indent its lines.</summary>
    public static string Wrap(string text, string indent, int width = 96)
    {
        var lines = new List<string>();
        foreach (var paragraph in text.Split('\n'))
        {
            var prefix = indent + new string(' ', paragraph.Length - paragraph.TrimStart().Length);
            var line = new System.Text.StringBuilder(prefix);
            var empty = true;
            foreach (var word in paragraph.TrimStart().Split(' '))
            {
                if (!empty && line.Length + 1 + word.Length > width)
                {
                    lines.Add(line.ToString());
                    line.Clear().Append(prefix);
                    empty = true;
                }

                line.Append(empty ? "" : " ").Append(word);
                empty = false;
            }

            lines.Add(line.ToString().TrimEnd());
        }

        return string.Join(Environment.NewLine, lines);
    }
}

internal static class WindowsConsole
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int handle);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool GetConsoleMode(IntPtr handle, out uint mode);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool SetConsoleMode(IntPtr handle, uint mode);

    /// <summary>Turns on ANSI colors in the Windows console (Windows 10+); false when that is not possible.</summary>
    public static bool EnableColors()
    {
        try
        {
            var handle = GetStdHandle(-11);
            if (!GetConsoleMode(handle, out var mode))
            {
                return false;
            }

            return SetConsoleMode(handle, mode | 0x0004 /* ENABLE_VIRTUAL_TERMINAL_PROCESSING */);
        }
        catch (Exception)
        {
            return false;
        }
    }
}
