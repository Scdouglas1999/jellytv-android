using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Tally.LgInstaller.Ipk;
using Tally.LgInstaller.Webos;
using Xunit;

namespace Tally.LgInstaller.Tests;

public class DevModeKeyTests
{
    private static string Key(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/keys", name));

    [Theory]
    [InlineData("webos_rsa")]
    [InlineData("webos_rsa_3des")]
    public void UnlocksTheTvsTraditionalPemWithThePassphrase(string name)
    {
        var pem = DevModeKey.Unlock(Key(name), "78DB5E");
        Assert.StartsWith("-----BEGIN RSA PRIVATE KEY-----\n", pem, StringComparison.Ordinal);
        Assert.DoesNotContain("ENCRYPTED", pem, StringComparison.Ordinal);
        using var rsa = RSA.Create();
        rsa.ImportFromPem(pem);
        Assert.Equal(2048, rsa.KeySize);
    }

    [Fact]
    public void TellsAWrongPassphrase()
    {
        var ex = Assert.Throws<DevModeKeyException>(() => DevModeKey.Unlock(Key("webos_rsa"), "78DB5F"));
        Assert.Equal("That passphrase does not unlock the TV's key.", ex.Message);
        Assert.Throws<DevModeKeyException>(() => DevModeKey.Unlock(Key("webos_rsa_3des"), ""));
        Assert.Throws<DevModeKeyException>(() => DevModeKey.Unlock("<html>Key Server</html>", "78DB5E"));
    }

    [Fact]
    public void TakesThePassphraseAsTheAppShowsIt()
    {
        Assert.Equal("78DB5E", DevModeKey.NormalizePassphrase(" 78db 5e "));
        Assert.NotNull(DevModeKey.Unlock(Key("webos_rsa"), DevModeKey.NormalizePassphrase("78db5e")));
    }

    [Fact]
    public void PassesAnOpenSshKeyOnToSshNet()
    {
        var key = Key("webos_rsa_openssh");
        Assert.Equal(key, DevModeKey.Unlock(key, "78DB5E"));
        // SSH.NET opens it with the passphrase, and refuses a wrong one
        using var ok = new Renci.SshNet.PrivateKeyFile(new MemoryStream(Encoding.ASCII.GetBytes(key)), "78DB5E");
        Assert.ThrowsAny<Exception>(() => new Renci.SshNet.PrivateKeyFile(new MemoryStream(Encoding.ASCII.GetBytes(key)), "000000"));
    }

    [Fact]
    public void BytesToKeyIsOpenSsls()
    {
        // openssl enc -aes-128-cbc (and -des-ede3-cbc) -md md5 -S 0102030405060708 -pass pass:78DB5E -P
        byte[] salt = [1, 2, 3, 4, 5, 6, 7, 8];
        Assert.Equal("E0582A2E5D6C2FEC81BF7E285FE91E24", Convert.ToHexString(DevModeKey.BytesToKey("78DB5E"u8.ToArray(), salt, 16)));
        Assert.Equal("E0582A2E5D6C2FEC81BF7E285FE91E24C286BE285CEA11E6", Convert.ToHexString(DevModeKey.BytesToKey("78DB5E"u8.ToArray(), salt, 24)));
    }

    [Fact]
    public async Task FetchesFromTheKeyServer()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var paths = new List<string>();
        _ = Task.Run(async () =>
        {
            using var c = await listener.AcceptTcpClientAsync();
            var s = c.GetStream();
            var buf = new byte[4096];
            var n = await s.ReadAsync(buf);
            paths.Add(Encoding.ASCII.GetString(buf, 0, n).Split(' ')[1]);
            var body = Encoding.ASCII.GetBytes(Key("webos_rsa"));
            await s.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"));
            await s.WriteAsync(body);
        });
        using var http = new HttpClient();
        var key = await DevModeKey.FetchAsync(http, "127.0.0.1", port, CancellationToken.None);
        Assert.Equal(Key("webos_rsa"), key);
        Assert.Equal(["/webos_rsa"], paths);
        listener.Stop();
        // Key Server off: nothing listens
        Assert.Null(await DevModeKey.FetchAsync(http, "127.0.0.1", port, CancellationToken.None));
    }
}

public class LunaTests
{
    [Fact]
    public void WritesTheCommandsLgsCliRuns()
    {
        Assert.Equal(
            "/usr/bin/luna-send-pub -i luna://com.webos.appInstallService/dev/install '{\"id\":\"io.github.scdouglas1999.tally\",\"ipkUrl\":\"/media/developer/temp/x.ipk\",\"subscribe\":true}'",
            Luna.Command(Luna.Install, Luna.InstallParams("io.github.scdouglas1999.tally", "/media/developer/temp/x.ipk"), subscribe: true));
        Assert.Equal(
            "/usr/bin/luna-send-pub -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"io.github.scdouglas1999.tally\"}'",
            Luna.Command(Luna.Launch, Luna.LaunchParams("io.github.scdouglas1999.tally")));
        Assert.Equal(
            "/usr/bin/luna-send-pub -n 1 luna://com.webos.service.tv.systemproperty/getSystemInfo '{\"keys\":[\"modelName\",\"sdkVersion\",\"firmwareVersion\",\"boardType\",\"otaId\"],\"subscribe\":false}'",
            Luna.Command(Luna.SystemInfo, Luna.SystemInfoParams()));
        Assert.Equal("'it'\\''s'", Luna.ShellQuote("it's"));
    }

    [Fact]
    public void ReadsRepliesEvenWhenOneIsSplitAcrossLines()
    {
        var replies = Luna.Replies("{\"a\":1}\n{\"b\":\n2}\n\n{\"c\":3}\n").ToList();
        Assert.Equal(3, replies.Count);
        Assert.Equal(2, (int)replies[1]["b"]!);
    }

    [Theory]
    [InlineData("{\"subscribed\":true,\"returnValue\":true}", InstallState.Working, null)]
    [InlineData("{\"statusValue\":35,\"details\":{\"state\":\"ipk parsing\"},\"returnValue\":true}", InstallState.Working, null)]
    [InlineData("{\"statusValue\":30,\"details\":{\"state\":\"installed\"},\"returnValue\":true}", InstallState.Installed, null)]
    [InlineData("{\"statusValue\":24,\"details\":{\"errorCode\":-8,\"reason\":\"Can install only 'com.lg.app.signage.dev' app on developer mode\",\"state\":\"install failed\"},\"returnValue\":true}", InstallState.Failed, "Can install only 'com.lg.app.signage.dev' app on developer mode")]
    [InlineData("{\"returnValue\":false,\"errorCode\":-2,\"errorText\":\"invalid ipkUrl\"}", InstallState.Failed, "invalid ipkUrl")]
    public void ReadsTheInstallSubscription(string reply, InstallState state, string? error)
    {
        var p = InstallProgress.From((JsonObject)JsonNode.Parse(reply)!);
        Assert.Equal(state, p.State);
        Assert.Equal(error, p.Error);
    }

    [Fact]
    public void NamesWebosAndTheYearItCameWith()
    {
        Assert.Equal(5, new SystemInfo("OLED55CX9LA", "5.2.0", "").WebosVersion);
        Assert.Equal(22, new SystemInfo("OLED55C2", "7.2.0", "").WebosVersion);
        Assert.Equal(25, new SystemInfo("OLED65C5", "10.1.0", "").WebosVersion);
        Assert.Equal(2022, new SystemInfo("", "7.2.0", "").FirstYear);
        Assert.Equal(2021, new SystemInfo("", "6.3.0", "").FirstYear);
        Assert.Null(new SystemInfo("", "", "").FirstYear);
    }

    [Fact]
    public void ExplainsTheTvsReasons()
    {
        Assert.StartsWith("The TV does not have enough free space", WebosTv.Explain("FAILED_IPKG_INSTALL", ""), StringComparison.Ordinal);
        Assert.StartsWith("The TV is busy", WebosTv.Explain("duplicate command", ""), StringComparison.Ordinal);
        Assert.Equal("The TV could not install Tally. It said: something new", WebosTv.Explain("something new", ""));
    }
}

public class WebosTvTests
{
    [Fact]
    public async Task InstallsAsAresInstallDoes()
    {
        var fake = new FakeTv();
        var tv = new WebosTv(fake);
        var ipk = ShellIpk.Build("http://192.0.2.10:8096", "", "", DateTimeOffset.UnixEpoch);
        var states = new List<string>();
        var result = await tv.InstallAsync(ipk, "io.github.scdouglas1999.tally_0.1.0_all.ipk", ShellIpk.AppId, states.Add, CancellationToken.None);
        Assert.True(result.Ok, result.Reason);
        Assert.Equal(["ipk parsing", "installing"], states);
        Assert.Equal(
            [
                "/usr/bin/test -d /media/developer/temp || /bin/mkdir -p /media/developer/temp",
                "sftp put /media/developer/temp/io.github.scdouglas1999.tally_0.1.0_all.ipk",
                "/usr/bin/tail -c 200 '/media/developer/temp/io.github.scdouglas1999.tally_0.1.0_all.ipk' | /usr/bin/md5sum",
                "/usr/bin/luna-send-pub -i luna://com.webos.appInstallService/dev/install '{\"id\":\"io.github.scdouglas1999.tally\",\"ipkUrl\":\"/media/developer/temp/io.github.scdouglas1999.tally_0.1.0_all.ipk\",\"subscribe\":true}'",
                "/bin/rm -f '/media/developer/temp/io.github.scdouglas1999.tally_0.1.0_all.ipk'",
            ],
            fake.Commands);
        Assert.Empty(fake.Files); // the package is removed after the install
    }

    [Fact]
    public async Task StopsOnACutCopyAndReportsAFailedInstall()
    {
        var ipk = ShellIpk.Build("http://192.0.2.10:8096", "", "", DateTimeOffset.UnixEpoch);
        var cut = new FakeTv { TruncateUploads = true };
        var r1 = await new WebosTv(cut).InstallAsync(ipk, "a.ipk", ShellIpk.AppId, null, CancellationToken.None);
        Assert.False(r1.Ok);
        Assert.StartsWith("The copy on the TV is not complete", r1.Reason, StringComparison.Ordinal);
        Assert.Equal(0, cut.Installs);

        var full = new FakeTv { InstallEnd = "{\"statusValue\":24,\"details\":{\"errorCode\":-5,\"reason\":\"FAILED_IPKG_INSTALL\",\"state\":\"install failed\"},\"returnValue\":true}" };
        var r2 = await new WebosTv(full).InstallAsync(ipk, "a.ipk", ShellIpk.AppId, null, CancellationToken.None);
        Assert.False(r2.Ok);
        Assert.StartsWith("The TV does not have enough free space", r2.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadsTheSessionTokenAndTheSystemInfo()
    {
        var fake = new FakeTv();
        var tv = new WebosTv(fake);
        Assert.Equal("0123456789abcdef0123456789abcdef", await tv.SessionTokenAsync(CancellationToken.None));
        Assert.Contains("sftp get /var/luna/preferences/devmode_enabled", fake.Commands);
        fake.Token = "not a token!";
        Assert.Equal("", await tv.SessionTokenAsync(CancellationToken.None));
        fake.Token = null;
        Assert.Equal("", await tv.SessionTokenAsync(CancellationToken.None));
        var info = await tv.SystemInfoAsync(CancellationToken.None);
        Assert.Equal(new SystemInfo("OLED55CX9LA", "5.2.0", "04.20.55"), info);
        Assert.True(await tv.LaunchAsync(ShellIpk.AppId, CancellationToken.None));
        fake.LaunchFails = true;
        Assert.False(await tv.LaunchAsync(ShellIpk.AppId, CancellationToken.None));
    }
}

public class ScannerTests
{
    [Fact]
    public async Task FindsTheTvAmongOtherAddresses()
    {
        // Developer Mode's SSH and Key Server listening on 127.0.0.1; 127.0.0.2-.4 answer nothing
        var ssh = new TcpListener(IPAddress.Loopback, 0);
        var key = new TcpListener(IPAddress.Loopback, 0);
        ssh.Start();
        key.Start();
        var scanner = new LgScanner
        {
            SshPort = ((IPEndPoint)ssh.LocalEndpoint).Port,
            KeyPort = ((IPEndPoint)key.LocalEndpoint).Port,
            WebosPort = 1, // nothing
            ConnectTimeout = TimeSpan.FromMilliseconds(300),
            SsdpTime = TimeSpan.FromMilliseconds(200),
        };
        var found = await scanner.ScanAsync(new[] { "127.0.0.2", "127.0.0.1", "127.0.0.3" }.Select(IPAddress.Parse), CancellationToken.None);
        var tv = Assert.Single(found);
        Assert.Equal(IPAddress.Loopback, tv.Address);
        Assert.True(tv.DeveloperMode);
        Assert.True(tv.KeyServer);
        Assert.Equal("Developer Mode is on, Key Server is on: ready", tv.Status);
        Assert.Equal("a device with Developer Mode's port open", tv.Label);
        key.Stop();
        var again = await scanner.ScanAsync([IPAddress.Loopback], CancellationToken.None);
        Assert.Equal("Developer Mode is on, Key Server is off (turn it on in the Developer Mode app)", Assert.Single(again).Status);
        ssh.Stop();
        Assert.Equal("Developer Mode is off", new LgFound(IPAddress.Loopback, "LG TV", "OLED55CX9LA", false, false, true).Status);
        Assert.Equal("LG TV, OLED55CX9LA", new LgFound(IPAddress.Loopback, "LG TV", "OLED55CX9LA", false, false, true).Label);
    }
}
