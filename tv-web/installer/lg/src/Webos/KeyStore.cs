using System.Text.Json;
using System.Text.Json.Serialization;

namespace Tally.LgInstaller.Webos;

/// <summary>A TV this PC installed on: its key (as the key server sent it, still locked) and the passphrase.</summary>
public sealed class SavedTv
{
    public string Key { get; set; } = "";
    public string Passphrase { get; set; } = "";
    public string Model { get; set; } = "";
}

[JsonSerializable(typeof(Dictionary<string, SavedTv>))]
internal sealed partial class KeyStoreJson : JsonSerializerContext;

/// <summary>
/// The TVs' keys, kept for the next install (an update does not need Key Server on or the passphrase again, as long
/// as Developer Mode was not set up anew): <c>%APPDATA%\Tally\LG</c>, <c>~/.config/Tally/LG</c>, readable by this user
/// only. LG's own CLI keeps the same things (the key file and the passphrase in its device list).
/// </summary>
public sealed class KeyStore(string directory)
{
    public string Directory { get; } = directory;

    public static string DefaultDirectory =>
        Environment.GetEnvironmentVariable("TALLY_LG_DATA") is { Length: > 0 } dir
            ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData, Environment.SpecialFolderOption.Create), "Tally", "LG");

    private string FilePath => Path.Combine(Directory, "tvs.json");

    public Dictionary<string, SavedTv> All()
    {
        try
        {
            return File.Exists(FilePath)
                ? JsonSerializer.Deserialize(File.ReadAllText(FilePath), KeyStoreJson.Default.DictionaryStringSavedTv) ?? new()
                : new();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return new();
        }
    }

    public SavedTv? For(string tv) => All().TryGetValue(tv, out var saved) ? saved : null;

    public void Save(string tv, SavedTv saved)
    {
        var all = All();
        all[tv] = saved;
        Write(all);
    }

    public void Forget(string tv)
    {
        var all = All();
        if (all.Remove(tv))
        {
            Write(all);
        }
    }

    private void Write(Dictionary<string, SavedTv> all)
    {
        System.IO.Directory.CreateDirectory(Directory);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(all, KeyStoreJson.Default.DictionaryStringSavedTv));
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(FilePath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }
}
