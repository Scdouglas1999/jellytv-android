using System.Net;
using System.Text;
using Tally.LgInstaller.Ipk;
using Tally.LgInstaller.Webos;
using Xunit;

namespace Tally.LgInstaller.Tests;

/// <summary>
/// Tally for LG from start to finish against a fake TV (<see cref="FakeTv"/>), a fake key server and a fake Jellyfin,
/// driven through the console as a person would.
/// </summary>
public class FlowTests
{
    private static readonly string TvKey = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures/keys/webos_rsa"));

    private sealed class Web(Func<string, string?> route) : HttpMessageHandler
    {
        public List<string> Urls { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            Urls.Add(url);
            var body = route(url);
            if (body is null)
            {
                throw new HttpRequestException("no answer", null, null);
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8) });
        }
    }

    private static string? Default(string url) => url switch
    {
        "http://192.0.2.40:9991/webos_rsa" => TvKey,
        "http://192.0.2.10:8096/System/Info/Public" => "{\"ServerName\":\"Den\",\"Version\":\"10.10.6\",\"Id\":\"abc\"}",
        "http://192.0.2.10:8096/JellyTV/TV/manifest.json" => "{\"js\":\"app.js\"}",
        _ => null,
    };

    private sealed record Run(int Code, string Output, FakeTv Tv, List<(string Host, int Port, string User, string Key, string? Pass)> Connects, KeyStore Store, Web Web);

    private static async Task<Run> RunAsync(string input, LgOptions options, FakeTv? tv = null, Func<string, string?>? route = null,
        KeyStore? store = null, Func<string, string?, Exception?>? refuse = null)
    {
        tv ??= new FakeTv();
        var output = new StringWriter();
        var ui = new Ui(new StringReader(input), output, color: false);
        var web = new Web(route ?? Default);
        store ??= new KeyStore(Directory.CreateTempSubdirectory("tally-lg-tests-").FullName);
        var connects = new List<(string, int, string, string, string?)>();
        var flow = new LgInstallerFlow(ui, options, new HttpClient(web), store)
        {
            Networks = () => [],
            Clock = () => DateTimeOffset.UnixEpoch.AddYears(56),
            Connect = (host, port, user, key, pass, ct) =>
            {
                connects.Add((host, port, user, key, pass));
                if (refuse?.Invoke(key, pass) is { } ex)
                {
                    throw ex;
                }

                return Task.FromResult<ITvConnection>(tv);
            },
        };
        var code = await flow.RunAsync(CancellationToken.None);
        return new Run(code, output.ToString(), tv, connects, store, web);
    }

    [Fact]
    public async Task InstallsOnA2020Tv()
    {
        var run = await RunAsync("78db5e\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40", NoLaunch = false });
        Assert.Equal(0, run.Code);
        Assert.Contains("STEP 1 OF 4  FIND YOUR TV", run.Output);
        Assert.Contains("OK  Connected. webOS 5, OLED55CX9LA (webOS of 2020 TVs).", run.Output);
        Assert.Contains("OK  Found Den (Jellyfin 10.10.6) at http://192.0.2.10:8096.", run.Output);
        Assert.Contains("TV: ipk parsing", run.Output);
        Assert.Contains("OK  Tally is installed.", run.Output);
        Assert.Contains("On the TV, Tally shows a 6-digit code.", run.Output);
        Assert.Contains("Developer Mode stays on", run.Output);
        // the key server's key, unlocked with the passphrase as the app shows it; prisoner on 9922
        var c = Assert.Single(run.Connects);
        Assert.Equal(("192.0.2.40", 9922, "prisoner"), (c.Host, c.Port, c.User));
        Assert.StartsWith("-----BEGIN RSA PRIVATE KEY-----\nMII", c.Key, StringComparison.Ordinal);
        Assert.Null(c.Pass);
        // the package carried the server and the TV's session token
        Assert.Equal(1, run.Tv.Installs);
        Assert.Contains(run.Tv.Commands, x => x.Contains("applicationManager/launch", StringComparison.Ordinal));
        Assert.True(run.Tv.Disposed);
        // the key is kept for the next time
        Assert.Equal("78DB5E", run.Store.For("192.0.2.40")?.Passphrase);
    }

    [Fact]
    public async Task StampsTheServerAndTheSessionIntoTheShell()
    {
        byte[]? sent = null;
        var tv = new FakeTv { OnUpload = b => sent = b };
        var run = await RunAsync("78DB5E\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40", NoLaunch = true }, tv);
        Assert.Equal(0, run.Code);
        var data = IpkTests.ReadTarGz(IpkTests.ReadAr(sent!)[2].Bytes);
        var config = Encoding.UTF8.GetString(data.Single(e => e.Name.EndsWith("/config.js", StringComparison.Ordinal)).Bytes);
        Assert.Contains("\"server\": \"http://192.0.2.10:8096\"", config);
        Assert.Contains("\"devModeToken\": \"0123456789abcdef0123456789abcdef\"", config);
        Assert.DoesNotContain(run.Tv.Commands, x => x.Contains("applicationManager/launch", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AsksAgainAfterAWrongPassphrase()
    {
        var run = await RunAsync("123456\n78DB5E\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40" });
        Assert.Equal(0, run.Code);
        Assert.Contains("!!  That passphrase does not unlock the TV's key.", run.Output);
        Assert.Contains("Type the passphrase again", run.Output);
    }

    [Fact]
    public async Task ExplainsKeyServerOff()
    {
        var run = await RunAsync("q\n", new LgOptions { Tv = "192.0.2.41" });
        Assert.Equal(1, run.Code);
        Assert.Contains("The TV's Key Server did not answer at 192.0.2.41", run.Output);
        Assert.Contains("switch Key Server on", run.Output);
    }

    [Fact]
    public async Task UpdatesWithTheKeptKeyAndGetsANewOneWhenTheTvChangedIt()
    {
        var store = new KeyStore(Directory.CreateTempSubdirectory("tally-lg-tests-").FullName);
        await RunAsync("78DB5E\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40" }, store: store);
        // the next run: no passphrase asked, no key server
        var again = await RunAsync("192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40" }, store: store);
        Assert.Equal(0, again.Code);
        Assert.DoesNotContain("passphrase", again.Output);
        Assert.DoesNotContain(again.Web.Urls, u => u.Contains("9991", StringComparison.Ordinal));

        // Developer Mode set up anew: the kept key is refused, the new one is fetched
        var first = true;
        var renewed = await RunAsync("78DB5E\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40" }, store: store,
            refuse: (_, _) =>
            {
                if (!first)
                {
                    return null;
                }

                first = false;
                return new TvConnectException(ConnectFailure.KeyRefused, "Permission denied (publickey).");
            });
        Assert.Equal(0, renewed.Code);
        Assert.Contains("The TV has a new key since last time", renewed.Output);
        Assert.Equal(2, renewed.Connects.Count);
    }

    [Fact]
    public async Task ExplainsDeveloperModeOff()
    {
        var run = await RunAsync("78DB5E\nq\n", new LgOptions { Tv = "192.0.2.40" },
            refuse: (_, _) => new TvConnectException(ConnectFailure.NoAnswer, "Connection refused"));
        Assert.Equal(1, run.Code);
        Assert.Contains("Nothing answered on Developer Mode's port at 192.0.2.40", run.Output);
        Assert.Contains("Switch Dev Mode Status on", run.Output);
    }

    [Fact]
    public async Task RefusesAnOlderTvAndSaysWhatTheTvSaid()
    {
        var old = await RunAsync("78DB5E\n", new LgOptions { Tv = "192.0.2.40" }, new FakeTv { Sdk = "4.9.0" });
        Assert.Equal(1, old.Code);
        Assert.Contains("Tally needs a 2020 or newer LG TV (webOS 5 or newer); this TV has webOS 4.", old.Output);

        var full = await RunAsync("78DB5E\n192.0.2.10:8096\n", new LgOptions { Tv = "192.0.2.40" },
            new FakeTv { InstallEnd = "{\"statusValue\":24,\"details\":{\"errorCode\":-5,\"reason\":\"FAILED_IPKG_INSTALL\",\"state\":\"install failed\"},\"returnValue\":true}" });
        Assert.Equal(1, full.Code);
        Assert.Contains("!!  The TV does not have enough free space.", full.Output);
    }

    [Fact]
    public async Task WorksWithTheEmulatorsKeyAndWithoutASessionToken()
    {
        var unlocked = DevModeKey.Unlock(TvKey, "78DB5E");
        var file = Path.Combine(Directory.CreateTempSubdirectory("tally-lg-tests-").FullName, "webos_emul");
        await File.WriteAllTextAsync(file, unlocked);
        var run = await RunAsync("192.0.2.10:8096\n", new LgOptions { Tv = "127.0.0.1", SshPort = 6622, User = "developer", KeyFile = file },
            new FakeTv { Token = null, Sdk = "6.0.0" });
        Assert.Equal(0, run.Code);
        Assert.Equal(("127.0.0.1", 6622, "developer"), (run.Connects[0].Host, run.Connects[0].Port, run.Connects[0].User));
        Assert.Contains("did not give its Developer Mode session", run.Output);
        Assert.Null(run.Store.For("127.0.0.1"));
    }

    [Fact]
    public async Task WritesOnlyThePackage()
    {
        var dir = Directory.CreateTempSubdirectory("tally-lg-tests-").FullName;
        var output = Path.Combine(dir, "tally.ipk");
        var run = await RunAsync("", new LgOptions { PackageOnly = true, Server = "192.0.2.10:8096", Out = output });
        Assert.Equal(0, run.Code);
        Assert.Equal(["debian-binary", "control.tar.gz", "data.tar.gz"], IpkTests.ReadAr(await File.ReadAllBytesAsync(output)).Select(m => m.Name));
    }

    [Fact]
    public void ParsesItsOptions()
    {
        var o = LgOptions.Parse(["--tv", "192.0.2.40", "--passphrase", "78DB5E", "--server", "https://jf.example.com", "--yes", "--ssh-port", "6622", "--user", "developer"]);
        Assert.Equal(new LgOptions { Tv = "192.0.2.40", Passphrase = "78DB5E", Server = "https://jf.example.com", Yes = true, SshPort = 6622, User = "developer" }, o);
        Assert.Throws<ArgumentException>(() => LgOptions.Parse(["--wgt", "x"]));
        Assert.Throws<ArgumentException>(() => LgOptions.Parse(["--tv"]));
    }
}
