using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
#if JF12
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
#else
using Jellyfin.Data.Enums;
#endif
using Jellyfin.Plugin.Tally.Dvr;
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Tally.Api;

/// <summary>What <c>POST /JellyTV/Client/v1/recordings</c> takes: a game, or a team.</summary>
public sealed class RecordRequest
{
    /// <summary>Record this game (a scoreboard event id).</summary>
    [JsonPropertyName("gameId")] public string? GameId { get; set; }

    /// <summary>Record every game of this team (a scoreboard team id).</summary>
    [JsonPropertyName("teamId")] public string? TeamId { get; set; }

    /// <summary>Team rules: the league the rule is limited to, as a path ("baseball/mlb") or as the board shows it
    /// ("MLB"). Omitted: the league the team was found in (team ids are only unique within a league). "*": any league
    /// (college teams play several sports).</summary>
    [JsonPropertyName("league")] public string? League { get; set; }

    /// <summary>Team rules: keep the last N recorded games, 0 or omitted = all.</summary>
    [JsonPropertyName("keepLast")] public int? KeepLast { get; set; }
}

/// <summary>
/// The DVR's API. Client v1 (the apps and the web UI): list, record a game or a team, cancel a job, delete a rule,
/// delete a recording, storage. Admin: settings, folder check, the library button. Anonymous but signed: the
/// start-over playlist of a recording in progress. Anyone signed in may look; changing anything takes the Live TV
/// recording management permission (admins always have it).
/// </summary>
[ApiController]
[Authorize]
public class RecordingsController : ControllerBase
{
    private readonly DvrService _dvr;
    private readonly ScoreboardService _scoreboard;
    private readonly StreamSigner _signer;
    private readonly IAuthorizationContext _authContext;

    public RecordingsController(DvrService dvr, ScoreboardService scoreboard, StreamSigner signer, IAuthorizationContext authContext)
    {
        _dvr = dvr;
        _scoreboard = scoreboard;
        _signer = signer;
        _authContext = authContext;
    }

    private const string NoPermission = "Recording needs the \"Allow Live TV recording management\" permission: an admin can grant it under Dashboard, Users.";

    // ------------------------------------------------------------------ Client v1

    [HttpGet("JellyTV/Client/v1/recordings")]
    public async Task<IActionResult> List()
    {
        var (user, canManage, isAdmin) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        var libraryState = _dvr.LibraryStates();
        return Ok(new
        {
            canManage,
            reason = canManage ? null : NoPermission,
            rules = _dvr.Rules.Select(RuleDto),
            jobs = _dvr.Jobs.OrderBy(j => Order(j.State)).ThenBy(j => JobState.IsFinal(j.State) ? -(j.EndedAt ?? j.CreatedAt).ToUnixTimeSeconds() : j.Game.Start.ToUnixTimeSeconds())
                .Select(j => JobDto(j, isAdmin, libraryState))
        });
    }

    [HttpPost("JellyTV/Client/v1/recordings")]
    public async Task<IActionResult> Create([FromBody] RecordRequest request, CancellationToken cancellationToken)
    {
        var (user, canManage, _) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        if (!canManage)
        {
            return StatusCode(403, new { error = NoPermission });
        }

        if (!(Plugin.Instance?.Configuration.ScoresEnabled ?? true))
        {
            return Conflict(new { error = "Live scores are switched off: the DVR follows games by the scoreboard" });
        }

        var games = await _scoreboard.GetGamesAsync(cancellationToken).ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(request.GameId))
        {
            var game = games.FirstOrDefault(g => g.Id == request.GameId)
                       ?? (await Upcoming(cancellationToken).ConfigureAwait(false)).FirstOrDefault(g => g.Id == request.GameId);
            if (game == null)
            {
                return NotFound(new { error = "No such game on the scoreboard" });
            }

            if (game.State == "post")
            {
                return Conflict(new { error = "This game is over" });
            }

            var (rule, job, created) = _dvr.RecordGame(game, user.Value.Id, user.Value.Name);
            return StatusCode(created ? 201 : 200, new { rule = rule == null ? null : RuleDto(rule), job = JobDto(job, false, _dvr.LibraryStates()) });
        }

        if (!string.IsNullOrWhiteSpace(request.TeamId))
        {
            var all = games.Concat(await Upcoming(cancellationToken).ConfigureAwait(false)).ToList();
            var anyLeague = request.League == "*";
            var league = anyLeague ? null : request.League?.Trim();
            var found = all.FirstOrDefault(g => (league == null || string.Equals(g.LeaguePath, league, StringComparison.OrdinalIgnoreCase)
                                                                   || string.Equals(g.League, league, StringComparison.OrdinalIgnoreCase))
                                                && (g.Home.Id == request.TeamId || g.Away.Id == request.TeamId));
            if (found == null)
            {
                return NotFound(new { error = "No game of this team on the scoreboard in the next week" });
            }

            var team = found.Home.Id == request.TeamId ? found.Home : found.Away;
            var (rule, created) = _dvr.RecordTeam(team, anyLeague ? string.Empty : found.LeaguePath, request.KeepLast ?? 0, user.Value.Id, user.Value.Name);
            return StatusCode(created ? 201 : 200, new { rule = RuleDto(rule) });
        }

        return BadRequest(new { error = "Give a gameId or a teamId" });
    }

    [HttpDelete("JellyTV/Client/v1/recordings/jobs/{id}")]
    public async Task<IActionResult> Cancel(Guid id)
    {
        var (user, canManage, _) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        if (!canManage)
        {
            return StatusCode(403, new { error = NoPermission });
        }

        var error = _dvr.CancelJob(id);
        return error == null ? NoContent() : error == "not found" ? NotFound() : Conflict(new { error });
    }

    [HttpDelete("JellyTV/Client/v1/recordings/jobs/{id}/recording")]
    public async Task<IActionResult> DeleteRecording(Guid id)
    {
        var (user, canManage, _) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        if (!canManage)
        {
            return StatusCode(403, new { error = NoPermission });
        }

        var error = _dvr.DeleteRecording(id);
        return error == null ? NoContent() : error == "not found" ? NotFound() : Conflict(new { error });
    }

    [HttpDelete("JellyTV/Client/v1/recordings/rules/{id}")]
    public async Task<IActionResult> DeleteRule(Guid id)
    {
        var (user, canManage, _) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        if (!canManage)
        {
            return StatusCode(403, new { error = NoPermission });
        }

        return _dvr.DeleteRule(id) ? NoContent() : NotFound();
    }

    /// <summary>The recordings folder, its free space, what recordings use, the reserve, and (with a gameId) how much
    /// recording that game would take.</summary>
    [HttpGet("JellyTV/Client/v1/recordings/storage")]
    public async Task<IActionResult> Storage([FromQuery] string? gameId, CancellationToken cancellationToken)
    {
        var (user, _, isAdmin) = await WhoAsync().ConfigureAwait(false);
        if (user == null)
        {
            return Unauthorized();
        }

        var s = _dvr.GetStorage();
        object? estimate = null;
        if (!string.IsNullOrWhiteSpace(gameId))
        {
            var games = await _scoreboard.GetGamesAsync(cancellationToken).ConfigureAwait(false);
            var game = games.FirstOrDefault(g => g.Id == gameId)
                       ?? (await Upcoming(cancellationToken).ConfigureAwait(false)).FirstOrDefault(g => g.Id == gameId);
            if (game == null)
            {
                return NotFound(new { error = "No such game on the scoreboard" });
            }

            var e = _dvr.EstimateFor(game);
            estimate = new
            {
                gameId = e.GameId,
                bytes = e.Bytes,
                bitrate = Math.Round(e.Bitrate),
                bitrateMeasured = e.BitrateMeasured,
                secondsLeft = Math.Round(e.SecondsLeft),
                fits = e.Fits,
                message = e.Message
            };
        }

        return Ok(new
        {
            folder = isAdmin ? s.Folder : null,
            freeBytes = s.FreeBytes,
            totalBytes = s.TotalBytes,
            usedBytes = s.UsedBytes,
            reserveBytes = s.ReserveBytes,
            estimate
        });
    }

    // ------------------------------------------------------------------ admin

    [HttpGet("JellyTV/Recordings/Settings")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult GetSettings() => Ok(AdminView(_dvr.Settings));

    [HttpPost("JellyTV/Recordings/Settings")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult SaveSettings([FromBody] DvrSettings settings)
    {
        var s = settings.Normalized();
        if (s.Folder.Length > 0)
        {
            var error = CheckFolder(s.Folder);
            if (error != null)
            {
                return BadRequest(new { error });
            }
        }

        return Ok(AdminView(_dvr.SaveSettings(s)));
    }

    /// <summary>Free space for a folder the admin is about to choose (created if missing, checked for writing).</summary>
    [HttpGet("JellyTV/Recordings/Folder")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult CheckFolderSpace([FromQuery] string? path)
    {
        var folder = string.IsNullOrWhiteSpace(path) ? _dvr.DefaultFolder : path.Trim();
        var error = CheckFolder(folder);
        var space = DiskSpace.For(folder);
        return Ok(new { folder, ok = error == null, error, freeBytes = space?.FreeBytes, totalBytes = space?.TotalBytes });
    }

    [HttpPost("JellyTV/Recordings/Library")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> CreateLibrary()
    {
        var existing = _dvr.CoveringLibrary();
        if (existing != null)
        {
            return Ok(new { library = existing, created = false });
        }

        try
        {
            var name = await _dvr.CreateLibraryAsync().ConfigureAwait(false);
            return Ok(new { library = name, created = true });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    private object AdminView(DvrSettings settings)
    {
        var s = _dvr.GetStorage();
        return new
        {
            settings,
            folder = s.Folder,
            defaultFolder = _dvr.DefaultFolder,
            freeBytes = s.FreeBytes,
            totalBytes = s.TotalBytes,
            usedBytes = s.UsedBytes,
            library = _dvr.CoveringLibrary(),
            libraryAutoCreatedAt = _dvr.LibraryAutoCreatedAt
        };
    }

    private static string? CheckFolder(string folder)
    {
        if (!Path.IsPathRooted(folder))
        {
            return "Use a full path, like D:\\Tally Recordings or /media/recordings";
        }

        try
        {
            Directory.CreateDirectory(folder);
            var probe = Path.Combine(folder, ".tally-write-test");
            System.IO.File.WriteAllText(probe, "ok");
            System.IO.File.Delete(probe);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return "Jellyfin cannot write there: " + ex.Message;
        }
    }

    // ------------------------------------------------------------------ start over (signed, anonymous)

    /// <summary>Everything recorded so far as an EVENT playlist that keeps growing while the game is recorded, so a
    /// viewer can start from the first minute and catch up. Ends (#EXT-X-ENDLIST) once the recording stops; after the
    /// remux the library item replaces it.</summary>
    [HttpGet("JellyTV/Recordings/{jobId}/playlist.m3u8")]
    [AllowAnonymous]
    public IActionResult StartOver(string jobId, [FromQuery] string? s)
    {
        if (!Guid.TryParse(jobId, out var id) || !_signer.Validate("rec:" + id.ToString("N"), string.Empty, s))
        {
            return StatusCode(403);
        }

        var so = _dvr.StartOver(id);
        if (so == null)
        {
            return NotFound();
        }

        var (work, ended) = so.Value;
        var text = work.Playlist(seg => $"{seg.Number}.ts?s={Uri.EscapeDataString(s!)}", ended);
        Response.Headers.CacheControl = "no-store";
        return Content(text, "application/vnd.apple.mpegurl");
    }

    [HttpGet("JellyTV/Recordings/{jobId}/{number:int}.ts")]
    [AllowAnonymous]
    public IActionResult StartOverSegment(string jobId, int number, [FromQuery] string? s)
    {
        if (!Guid.TryParse(jobId, out var id) || !_signer.Validate("rec:" + id.ToString("N"), string.Empty, s))
        {
            return StatusCode(403);
        }

        var so = _dvr.StartOver(id);
        var seg = so?.Work.Segments.FirstOrDefault(x => x.Number == number);
        if (so == null || seg == null)
        {
            return NotFound();
        }

        var path = so.Value.Work.SegmentPath(seg);
        if (!System.IO.File.Exists(path))
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=3600";
        return PhysicalFile(path, "video/mp2t");
    }

    // ------------------------------------------------------------------ helpers

    private async Task<((Guid Id, string Name)? User, bool CanManage, bool IsAdmin)> WhoAsync()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        var u = auth.User;
        if (u == null)
        {
            return (null, false, false);
        }

        var admin = u.HasPermission(PermissionKind.IsAdministrator);
        return ((u.Id, u.Username), admin || u.HasPermission(PermissionKind.EnableLiveTvManagement), admin);
    }

    private async Task<List<GameInfo>> Upcoming(CancellationToken ct)
        => await _scoreboard.GetUpcomingAsync(ScoreboardService.ParseLeagues(Plugin.Instance?.Configuration.ScoreLeagues), 7, ct).ConfigureAwait(false);

    private static int Order(string state) => state switch
    {
        JobState.Recording => 0,
        JobState.Finishing => 1,
        JobState.Waiting => 2,
        JobState.Scheduled => 3,
        _ => 4
    };

    /// <summary>A job as the apps see it. <c>libraryState</c>: "ready" (<c>itemId</c> is set), "adding" (a library covers
    /// the file, Jellyfin has not added it yet) or "noLibrary" (no library covers the recordings folder).</summary>
    private object JobDto(RecordingJob j, bool isAdmin, Func<RecordingJob, string> libraryState) => new
    {
        id = j.Id.ToString("N"),
        ruleId = j.RuleId.ToString("N"),
        state = j.State,
        reason = j.Reason,
        stopReason = j.StopReason,
        title = j.Game.Title,
        game = new
        {
            id = j.Game.Id,
            league = j.Game.League,
            leaguePath = j.Game.LeaguePath,
            start = j.Game.Start,
            away = Team(j.Game.Away),
            home = Team(j.Game.Home)
        },
        createdAt = j.CreatedAt,
        startedAt = j.StartedAt,
        endedAt = j.EndedAt,
        channelName = j.ChannelName,
        bytes = j.Bytes,
        seconds = Math.Round(j.Seconds),
        bitrate = j.Bitrate is { } b ? Math.Round(b) : (double?)null,
        lastSegmentAt = j.LastSegmentAt,
        fileBytes = j.FileBytes,
        filePath = isAdmin ? j.FilePath : null,
        itemId = j.ItemId,
        libraryState = libraryState(j),
        startOverPath = j.State == JobState.Recording && j.Segments > 0 ? Request.PathBase.Value + DvrEnricher.StartOverPath(_signer, j.Id) : null
    };

    private static object RuleDto(RecordingRule r) => new
    {
        id = r.Id.ToString("N"),
        kind = r.Kind,
        title = r.Title,
        leaguePath = r.LeaguePath,
        gameId = r.GameId,
        teamId = r.TeamId,
        teamName = r.TeamName,
        keepLast = r.KeepLast,
        createdBy = r.CreatedBy.ToString("N"),
        createdByName = r.CreatedByName,
        createdAt = r.CreatedAt
    };

    private static object Team(TeamSnapshot t) => new { id = t.Id, abbr = t.Abbr, name = t.Name, shortName = t.ShortName, logo = t.Logo };
}
