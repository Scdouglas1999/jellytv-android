using System.Net.Sockets;
using System.Text;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace Tally.LgInstaller.Webos;

/// <summary>What the installer does on the TV: run a command (its output line by line), copy a file, read a file.</summary>
public interface ITvConnection : IAsyncDisposable
{
    /// <summary>
    /// Runs <paramref name="command"/> through the TV's shell; <paramref name="onLine"/> sees each output line and
    /// returns true to stop the command there (a Luna subscription that has said what it had to say).
    /// </summary>
    Task<string> RunAsync(string command, Func<string, bool>? onLine, CancellationToken ct);

    Task UploadAsync(byte[] data, string path, CancellationToken ct);

    /// <summary>A small file's bytes, or null when it cannot be read.</summary>
    Task<byte[]?> ReadAsync(string path, CancellationToken ct);
}

public enum ConnectFailure
{
    /// <summary>Nothing listens on the SSH port: Developer Mode is off (or the TV was not restarted after it).</summary>
    NoAnswer,
    /// <summary>The TV refused the key: a key from before Developer Mode was switched off and on.</summary>
    KeyRefused,
    /// <summary>Something answered that is not the TV's SSH.</summary>
    NotSsh,
}

public sealed class TvConnectException(ConnectFailure failure, string message) : Exception(message)
{
    public ConnectFailure Failure { get; } = failure;
}

/// <summary>
/// SSH and SFTP to the TV's Developer Mode (SSH.NET, MIT): port 9922, user <c>prisoner</c>, the key from the key
/// server; the emulator's is 6622, <c>developer</c>. The TV's host key is legacy <c>ssh-rsa</c> and changes whenever
/// Developer Mode is set up again, so it is accepted as it comes (as LG's CLI does) and written to the log.
/// </summary>
public sealed class SshTvConnection : ITvConnection
{
    private readonly SshClient _ssh;
    private readonly ConnectionInfo _info;
    private SftpClient? _sftp;

    public string HostKey { get; private set; } = "";

    private SshTvConnection(ConnectionInfo info)
    {
        _info = info;
        _ssh = new SshClient(info);
        _ssh.HostKeyReceived += Accept;
    }

    private void Accept(object? sender, HostKeyEventArgs e)
    {
        HostKey = e.HostKeyName + " " + e.FingerPrintSHA256;
        e.CanTrust = true;
    }

    public static async Task<SshTvConnection> ConnectAsync(string host, int port, string user, string privateKeyPem, string? passphrase, CancellationToken ct)
    {
        PrivateKeyFile key;
        try
        {
            using var keyStream = new MemoryStream(Encoding.ASCII.GetBytes(privateKeyPem));
            key = passphrase is null ? new PrivateKeyFile(keyStream) : new PrivateKeyFile(keyStream, passphrase);
        }
        catch (Exception ex) when (ex is SshException or ArgumentException or InvalidOperationException)
        {
            throw new DevModeKeyException("The TV's key could not be read (" + ex.Message + ").");
        }

        var info = new ConnectionInfo(host, port, user, new PrivateKeyAuthenticationMethod(user, key))
        {
            Timeout = TimeSpan.FromSeconds(10),
        };
        var c = new SshTvConnection(info);
        try
        {
            await c._ssh.ConnectAsync(ct).ConfigureAwait(false);
        }
        catch (SshAuthenticationException ex)
        {
            c._ssh.Dispose();
            throw new TvConnectException(ConnectFailure.KeyRefused, ex.Message);
        }
        catch (SocketException ex)
        {
            c._ssh.Dispose();
            throw new TvConnectException(ConnectFailure.NoAnswer, ex.Message);
        }
        catch (Exception ex) when (ex is SshConnectionException or SshOperationTimeoutException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            c._ssh.Dispose();
            throw new TvConnectException(ex is SshConnectionException ? ConnectFailure.NotSsh : ConnectFailure.NoAnswer, ex.Message);
        }

        return c;
    }

    public async Task<string> RunAsync(string command, Func<string, bool>? onLine, CancellationToken ct)
    {
        using var cmd = _ssh.CreateCommand(command);
        cmd.CommandTimeout = TimeSpan.FromMinutes(5);
        var run = cmd.ExecuteAsync(ct);
        var all = new StringBuilder();
        using (var reader = new StreamReader(cmd.OutputStream, Encoding.UTF8))
        {
            while (await reader.ReadLineAsync(ct).ConfigureAwait(false) is { } line)
            {
                all.Append(line).Append('\n');
                if (onLine?.Invoke(line) == true)
                {
                    // a subscription (luna-send -i) runs until its input closes: done listening
                    try
                    {
                        cmd.CancelAsync(forceKill: false, millisecondsTimeout: 2000);
                    }
                    catch (Exception ex) when (ex is SshException or InvalidOperationException or TimeoutException)
                    {
                        // the channel closes with the connection
                    }

                    break;
                }
            }
        }

        try
        {
            await run.ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is OperationCanceledException or SshException && !ct.IsCancellationRequested)
        {
            // canceled above
        }

        return all.ToString();
    }

    private async Task<SftpClient> SftpAsync(CancellationToken ct)
    {
        if (_sftp is { IsConnected: true })
        {
            return _sftp;
        }

        _sftp = new SftpClient(_info);
        _sftp.HostKeyReceived += Accept;
        await _sftp.ConnectAsync(ct).ConfigureAwait(false);
        return _sftp;
    }

    public async Task UploadAsync(byte[] data, string path, CancellationToken ct)
    {
        try
        {
            var sftp = await SftpAsync(ct).ConfigureAwait(false);
            using var s = new MemoryStream(data);
            await sftp.UploadFileAsync(s, path, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is SshException or IOException)
        {
            // as LG's CLI: when SFTP is not there, the shell writes the file (novacom.js: `/bin/cat > "<path>"`)
            using var cmd = _ssh.CreateCommand("/bin/cat > " + Luna.ShellQuote(path));
            var run = cmd.ExecuteAsync(ct);
            using (var input = cmd.CreateInputStream())
            {
                await input.WriteAsync(data, ct).ConfigureAwait(false);
            }

            await run.ConfigureAwait(false);
        }
    }

    public async Task<byte[]?> ReadAsync(string path, CancellationToken ct)
    {
        try
        {
            var sftp = await SftpAsync(ct).ConfigureAwait(false);
            using var s = new MemoryStream();
            await sftp.DownloadFileAsync(path, s, ct).ConfigureAwait(false);
            return s.ToArray();
        }
        catch (Exception ex) when (ex is SshException or IOException)
        {
            var text = await RunAsync("/bin/cat " + Luna.ShellQuote(path) + " 2>/dev/null", null, ct).ConfigureAwait(false);
            return text.Length > 0 ? Encoding.UTF8.GetBytes(text) : null;
        }
    }

    public ValueTask DisposeAsync()
    {
        _sftp?.Dispose();
        _ssh.Dispose();
        return ValueTask.CompletedTask;
    }
}
