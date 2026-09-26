using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
#if JF12
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
#else
using Jellyfin.Data.Enums;
#endif
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using Jellyfin.Plugin.Tally.Sources;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tally.Api;

[ApiController]
[Route("JellyTV")]
public class TallyController : ControllerBase
{
    private readonly SourceManager _sourceManager;
    private readonly StreamSigner _signer;
    private readonly UserSettingsStore _settingsStore;
    private readonly ScoreboardService _scoreboard;
    private readonly IAuthorizationContext _authContext;
    private readonly BrowserRuntime _browser;
    private readonly LgDevModeService _lgDevMode;
    private readonly ILogger<TallyController> _logger;

    public TallyController(
        SourceManager sourceManager,
        StreamSigner signer,
        UserSettingsStore settingsStore,
        ScoreboardService scoreboard,
        IAuthorizationContext authContext,
        BrowserRuntime browser,
        LgDevModeService lgDevMode,
        ILogger<TallyController> logger)
    {
        _lgDevMode = lgDevMode;
        _sourceManager = sourceManager;
        _signer = signer;
        _settingsStore = settingsStore;
        _scoreboard = scoreboard;
        _authContext = authContext;
        _browser = browser;
        _logger = logger;
    }

    [HttpGet("Status")]
    [Authorize]
    public async Task<IActionResult> Status()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        return Ok(new
        {
            name = "JellyTV",
            version = (Plugin.Instance?.Version ?? typeof(Plugin).Assembly.GetName().Version)?.ToString(),
            build = typeof(Plugin).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
            pluginId = Plugin.PluginGuid,
            loadedAt = _sourceManager.LoadedAt,
            channelCount = _sourceManager.GetChannels().Count,
            sourceErrors = _sourceManager.SourceErrors,
            isAdmin = auth.User?.HasPermission(PermissionKind.IsAdministrator) ?? false,
            allowNonAdmin = Plugin.Instance?.Configuration.AllowNonAdminUsers ?? true,
            scoresEnabled = Plugin.Instance?.Configuration.ScoresEnabled ?? true,
            replaceLiveTv = Plugin.Instance?.Configuration.ReplaceLiveTv ?? true,
            webLook = Plugin.Instance?.Configuration.WebLook ?? true,
            getUrl = GetController.ServerAddress(Request) + "/JellyTV/Get",
            // the headless browser web page sources use: idle (not needed yet), preparing, ready or failed
            browser = BrowserJson(_browser.Status),
            // LG TVs whose Developer Mode this server keeps on (the settings page's line); no tokens
            lgDevMode = LgJson(_lgDevMode.Summary())
        });
    }

    private static object LgJson(LgDevModeSummary s)
        => new { tvs = s.Tvs, renewedAt = s.RenewedAt, failing = s.Failing, lastError = s.LastError };

    private static object BrowserJson(BrowserRuntime.StatusInfo b)
        => new { state = b.State, message = b.Message, browser = b.Browser, downloadMb = b.DownloadMb };

    [HttpGet("Channels")]
    [Authorize]
    public IActionResult Channels()
    {
        var now = DateTimeOffset.UtcNow;
        var channels = _sourceManager.GetChannels().Select(c =>
        {
            var (current, next) = _sourceManager.GetNowNext(c.Id);
            return new
            {
                id = c.Id,
                name = c.Name,
                logo = c.LogoUrl,
                group = c.Group,
                source = c.SourceName,
                tvgId = c.TvgId,
                hasEpg = current != null || next != null,
                now = current,
                next,
                streamUrl = ProxyController.BuildLiveUrl(Request, _signer, c.Id)
            };
        });

        return Ok(new { serverTime = now, channels });
    }

    [HttpGet("Guide")]
    [Authorize]
    public IActionResult Guide([FromQuery] DateTimeOffset? start, [FromQuery] DateTimeOffset? end, [FromQuery] string? channelId)
    {
        var s = start ?? DateTimeOffset.UtcNow.AddHours(-1);
        var e = end ?? DateTimeOffset.UtcNow.AddHours(6);

        var channels = string.IsNullOrEmpty(channelId)
            ? _sourceManager.GetChannels()
            : _sourceManager.GetChannels().Where(c => c.Id == channelId).ToList();

        var result = channels.Select(c => new
        {
            id = c.Id,
            name = c.Name,
            logo = c.LogoUrl,
            group = c.Group,
            programmes = _sourceManager.GetProgrammes(c.Id, s, e)
        });

        return Ok(new { start = s, end = e, channels = result });
    }

    [HttpGet("Stream/{channelId}")]
    [Authorize]
    public IActionResult Stream(string channelId)
    {
        var channel = _sourceManager.GetChannel(channelId);
        if (channel == null)
        {
            return NotFound();
        }

        return Ok(new
        {
            id = channel.Id,
            url = ProxyController.BuildLiveUrl(Request, _signer, channel.Id)
        });
    }

    /// <summary>Live games with score, situation, last play, heat and the channels carrying them.</summary>
    [HttpGet("Scores")]
    [Authorize]
    public async Task<IActionResult> Scores()
    {
        var now = DateTimeOffset.UtcNow;
        if (!(Plugin.Instance?.Configuration.ScoresEnabled ?? true))
        {
            return Ok(new { serverTime = now, enabled = false, games = Array.Empty<GameInfo>(), errors = new Dictionary<string, string>() });
        }

        var games = await _scoreboard.GetGamesAsync(HttpContext.RequestAborted).ConfigureAwait(false);
        var probes = _sourceManager.GetChannels()
            .Select(c => new ChannelProbe(c.Id, c.Name, _sourceManager.GetNowNext(c.Id).Now?.Title))
            .ToList();
        GameChannelMatcher.Match(games, probes);
        foreach (var g in games)
        {
            GameHeat.Apply(g, now);
        }

        return Ok(new { serverTime = now, enabled = true, games, errors = _scoreboard.Errors });
    }

    [HttpGet("UserSettings")]
    [Authorize]
    public async Task<IActionResult> GetUserSettings()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User == null)
        {
            return Unauthorized();
        }

        var settings = _settingsStore.Get(auth.User.Id);
        if (_sourceManager.GetChannels().Count > 0 && UserSettingsMigrator.MigrateChannelIds(settings, _sourceManager.ResolveId))
        {
            _settingsStore.Save(auth.User.Id, settings); // favorites saved under the old URL-derived ids
        }

        return Ok(settings);
    }

    [HttpPut("UserSettings")]
    [Authorize]
    public async Task<IActionResult> SaveUserSettings([FromBody] JsonObject settings)
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User == null)
        {
            return Unauthorized();
        }

        _settingsStore.Save(auth.User.Id, settings);
        return NoContent();
    }

    [HttpPost("Refresh")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> Refresh()
    {
        _browser.RetryIfFailed();
        await _sourceManager.RefreshAsync(HttpContext.RequestAborted).ConfigureAwait(false);
        return Ok(new { channelCount = _sourceManager.GetChannels().Count, errors = _sourceManager.SourceErrors });
    }
}
