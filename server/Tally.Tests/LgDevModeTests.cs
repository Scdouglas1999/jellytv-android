using System.Net;
using System.Text;
using Jellyfin.Plugin.Tally.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Tally.Tests;

/// <summary>
/// Keeping LG Developer Mode on: LG's answers as the community tools record them (gabe565/webos-dev-mode's fixtures:
/// reset {"result":"success","errorCode":"200","errorMsg":"GNL"}, check "…","errorMsg":"1000:00:00"}, failure
/// {"result":"fail","errorCode":"ERR_005","errorMsg":"Check user session"}), against a fake LG server.
/// </summary>
public class LgDevModeTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("tally-lg-").FullName;
    private readonly FakeLg _lg = new();
    private DateTimeOffset _now = new(2026, 9, 25, 12, 0, 0, TimeSpan.Zero);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private LgDevModeService Service() =>
        new(() => new HttpClient(_lg), NullLogger.Instance, () => Path.Combine(_dir, "lg-devmode.json")) { Clock = () => _now };

    private sealed class FakeLg : HttpMessageHandler
    {
        public List<string> Requests { get; } = new();
        public string Reset { get; set; } = "{\"result\":\"success\",\"errorCode\":\"200\",\"errorMsg\":\"GNL\"}";
        public string Check { get; set; } = "{\"result\":\"success\",\"errorCode\":\"200\",\"errorMsg\":\"999:59:58\"}";
        public bool Down { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            Requests.Add(url);
            if (Down)
            {
                throw new HttpRequestException("connection refused");
            }

            var body = url.Contains("ResetDevModeSession", StringComparison.Ordinal) ? Reset : Check;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public void Reads_LGs_Answers()
    {
        Assert.Equal(new LgDevModeService.Outcome(true, "GNL", null), LgDevModeService.Parse("{\"result\":\"success\",\"errorCode\":\"200\",\"errorMsg\":\"GNL\"}"));
        var fail = LgDevModeService.Parse("{\"result\":\"fail\",\"errorCode\":\"ERR_005\",\"errorMsg\":\"Check user session\"}");
        Assert.False(fail.Ok);
        Assert.Equal("ERR_005 Check user session", fail.Error);
        Assert.False(LgDevModeService.Parse("<html>maintenance</html>").Ok);
        Assert.True(LgDevModeService.IsTimeLeft("1000:00:00"));
        Assert.True(LgDevModeService.IsTimeLeft("49:59:07"));
        Assert.False(LgDevModeService.IsTimeLeft("GNL"));
    }

    [Fact]
    public async Task Registers_A_TV_Renews_It_At_Once_Then_Daily()
    {
        var service = Service();
        Assert.True(service.Register("tv-1", "LG OLED55CX9LA", "0123456789abcdef0123"));
        Assert.Equal(1, await service.RenewDueAsync(CancellationToken.None));
        Assert.Equal(
            new[]
            {
                "https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=0123456789abcdef0123",
                "https://developer.lge.com/secure/CheckDevModeSession.dev?sessionToken=0123456789abcdef0123",
            },
            _lg.Requests);
        var tv = Assert.Single(service.Tvs);
        Assert.Equal(_now, tv.RenewedAt);
        Assert.Equal("999:59:58", tv.Remaining);
        Assert.Null(tv.LastError);

        // not again the same day
        _now = _now.AddHours(23);
        Assert.Equal(0, await service.RenewDueAsync(CancellationToken.None));
        _now = _now.AddHours(1);
        Assert.Equal(1, await service.RenewDueAsync(CancellationToken.None));

        var summary = service.Summary();
        Assert.Equal(new LgDevModeSummary(1, _now, 0, null), summary);
    }

    [Fact]
    public async Task A_Failure_Is_Logged_Kept_And_Tried_Again_After_An_Hour()
    {
        var service = Service();
        service.Register("tv-1", "LG OLED55CX9LA", "0123456789abcdef0123");
        _lg.Reset = "{\"result\":\"fail\",\"errorCode\":\"ERR_005\",\"errorMsg\":\"Check user session\"}";
        Assert.Equal(0, await service.RenewDueAsync(CancellationToken.None));
        Assert.Equal("ERR_005 Check user session", service.Tvs[0].LastError);
        Assert.Equal(new LgDevModeSummary(1, null, 1, "ERR_005 Check user session"), service.Summary());
        _now = _now.AddMinutes(30);
        Assert.Equal(0, await service.RenewDueAsync(CancellationToken.None));
        Assert.Single(_lg.Requests); // not yet
        _lg.Down = true;
        _now = _now.AddMinutes(31);
        await service.RenewDueAsync(CancellationToken.None);
        Assert.StartsWith("LG's server did not answer", service.Tvs[0].LastError, StringComparison.Ordinal);
        _lg.Down = false;
        _lg.Reset = "{\"result\":\"success\",\"errorCode\":\"200\",\"errorMsg\":\"GNL\"}";
        _now = _now.AddHours(1);
        Assert.Equal(1, await service.RenewDueAsync(CancellationToken.None));
        Assert.Null(service.Tvs[0].LastError);
    }

    [Fact]
    public async Task A_TV_Failing_For_Two_Weeks_Is_Forgotten()
    {
        var service = Service();
        service.Register("tv-1", "LG OLED55CX9LA", "0123456789abcdef0123");
        _lg.Reset = "{\"result\":\"fail\",\"errorCode\":\"ERR_005\",\"errorMsg\":\"Check user session\"}";
        await service.RenewDueAsync(CancellationToken.None);
        _now = _now.AddDays(15);
        await service.RenewDueAsync(CancellationToken.None);
        Assert.Empty(service.Tvs);
    }

    [Fact]
    public void One_Entry_Per_TV_Tokens_Only_And_Kept_Across_Restarts()
    {
        var service = Service();
        Assert.False(service.Register("tv-1", "LG", "short"));
        Assert.False(service.Register("tv-1", "LG", "has spaces in it"));
        Assert.False(service.Register("tv-1", "LG", "../../etc/passwd000"));
        Assert.False(service.Register("", "LG", "0123456789abcdef0123"));
        Assert.True(service.Register("tv-1", "LG OLED55CX9LA", "0123456789abcdef0123"));
        // Tally reinstalled with a new token (Developer Mode switched off and on): replaces the entry
        Assert.True(service.Register("tv-1", "LG OLED55CX9LA", "abcdef0123456789abcd"));
        // the same token from a new install of the app (new device id): still one TV
        Assert.True(service.Register("tv-2", "LG OLED55CX9LA", "abcdef0123456789abcd"));
        var tv = Assert.Single(service.Tvs);
        Assert.Equal("tv-2", tv.DeviceId);
        Assert.True(service.Register("tv-3", "LG\u0007 OLED65C1", "fedcba9876543210fedc"));

        var again = Service();
        Assert.Equal(2, again.Tvs.Count);
        Assert.Equal("LG OLED65C1", again.Tvs[1].Name);
        Assert.DoesNotContain("0123456789abcdef0123", File.ReadAllText(Path.Combine(_dir, "lg-devmode.json")), StringComparison.Ordinal);
    }

    [Fact]
    public void Keeps_At_Most_Twenty_TVs()
    {
        var service = Service();
        for (var i = 0; i < 25; i++)
        {
            service.Register("tv-" + i, "LG", "token" + i.ToString("D10", System.Globalization.CultureInfo.InvariantCulture));
        }

        Assert.Equal(LgDevModeService.MaxTvs, service.Tvs.Count);
        Assert.Equal("tv-24", service.Tvs[^1].DeviceId);
    }
}
