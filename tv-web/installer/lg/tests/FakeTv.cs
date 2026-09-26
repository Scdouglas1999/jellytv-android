using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Tally.LgInstaller.Webos;

namespace Tally.LgInstaller.Tests;

/// <summary>
/// An LG TV in Developer Mode as the installer sees it over SSH: the commands LG's CLI runs and what a TV answers
/// (the install subscription's messages are those of a real TV's log: statusValue 35 "ipk parsing", 36, 37,
/// "installing", 30 "installed"; webosose.org appinstallservice reference and a TV log quoted in the research).
/// </summary>
public sealed class FakeTv : ITvConnection
{
    public List<string> Commands { get; } = [];
    public Dictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);
    public string Model { get; set; } = "OLED55CX9LA";
    public string Sdk { get; set; } = "5.2.0";
    public string? Token { get; set; } = "0123456789abcdef0123456789abcdef";
    /// <summary>The install's last message: success by default.</summary>
    public string InstallEnd { get; set; } = "{\"id\":\"com.ares.defaultName\",\"statusValue\":30,\"details\":{\"packageId\":\"io.github.scdouglas1999.tally\",\"state\":\"installed\",\"simpleStatus\":\"install\"},\"returnValue\":true}";
    public bool TruncateUploads { get; set; }
    public Action<byte[]>? OnUpload { get; set; }
    public bool LaunchFails { get; set; }
    public int Installs { get; private set; }
    public bool Disposed { get; private set; }

    public Task<string> RunAsync(string command, Func<string, bool>? onLine, CancellationToken ct)
    {
        Commands.Add(command);
        var lines = Answer(command);
        var output = new StringBuilder();
        foreach (var line in lines)
        {
            output.Append(line).Append('\n');
            if (onLine?.Invoke(line) == true)
            {
                break;
            }
        }

        return Task.FromResult(output.ToString());
    }

    private IEnumerable<string> Answer(string command)
    {
        if (command.Contains("getSystemInfo", StringComparison.Ordinal))
        {
            yield return $"{{\"modelName\":\"{Model}\",\"sdkVersion\":\"{Sdk}\",\"firmwareVersion\":\"04.20.55\",\"boardType\":\"K7LP_DVB\",\"otaId\":\"HE_DTV_W20P_AFADABAA\",\"returnValue\":true}}";
        }
        else if (command.Contains("/tail -c 200", StringComparison.Ordinal))
        {
            var path = command[(command.IndexOf('\'') + 1)..command.LastIndexOf('\'')];
            var bytes = Files[path];
            yield return Convert.ToHexStringLower(MD5.HashData(bytes.AsSpan(Math.Max(0, bytes.Length - 200)))) + "  -";
        }
        else if (command.Contains("appInstallService/dev/install", StringComparison.Ordinal))
        {
            Installs++;
            var json = JsonNode.Parse(command[(command.IndexOf('\'') + 1)..command.LastIndexOf('\'')])!;
            if (!Files.ContainsKey(json["ipkUrl"]!.ToString()))
            {
                yield return "{\"returnValue\":false,\"errorCode\":-2,\"errorText\":\"invalid ipkUrl\"}";
                yield break;
            }

            yield return "{\"subscribed\":true,\"returnValue\":true}";
            // LG's webOS 5 emulator sends each state several times
            for (var i = 0; i < 3; i++)
            {
                yield return "{\"id\":\"com.ares.defaultName\",\"statusValue\":35,\"details\":{\"installBasePath\":\"/media/developer\",\"simpleStatus\":\"install\",\"state\":\"ipk parsing\"},\"returnValue\":true}";
            }

            yield return "{\"id\":\"com.ares.defaultName\",\"statusValue\":36,\"details\":{\"packageId\":\"io.github.scdouglas1999.tally\",\"state\":\"installing\"},\"returnValue\":true}";
            yield return InstallEnd;
            // a subscription keeps going until the client stops listening
            yield return "{\"id\":\"com.ares.defaultName\",\"statusValue\":1,\"details\":{\"state\":\"never read\"},\"returnValue\":true}";
        }
        else if (command.Contains("applicationManager/launch", StringComparison.Ordinal))
        {
            yield return LaunchFails ? "{\"returnValue\":false,\"errorCode\":-101,\"errorText\":\"not found\"}" : "{\"returnValue\":true,\"processId\":\"1003\"}";
        }
        else if (command.Contains("closeByAppId", StringComparison.Ordinal))
        {
            yield return "{\"returnValue\":false,\"errorCode\":-1,\"errorText\":\"app is not running\"}";
        }
        else if (command.StartsWith("/bin/rm -f", StringComparison.Ordinal))
        {
            Files.Remove(command[(command.IndexOf('\'') + 1)..command.LastIndexOf('\'')]);
        }
    }

    public Task UploadAsync(byte[] data, string path, CancellationToken ct)
    {
        Commands.Add("sftp put " + path);
        OnUpload?.Invoke(data);
        Files[path] = TruncateUploads ? data[..(data.Length / 2)] : data;
        return Task.CompletedTask;
    }

    public Task<byte[]?> ReadAsync(string path, CancellationToken ct)
    {
        Commands.Add("sftp get " + path);
        return Task.FromResult(path == WebosTv.SessionTokenFile && Token is not null ? Encoding.ASCII.GetBytes(Token) : null);
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}
