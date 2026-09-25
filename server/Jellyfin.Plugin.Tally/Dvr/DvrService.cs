using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Tally.Client;
using Jellyfin.Plugin.Tally.Live;
using Jellyfin.Plugin.Tally.Models;
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using Jellyfin.Plugin.Tally.Sources;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tally.Dvr;

/// <summary>
/// The DVR. Rules (a game, or every game of a team) become jobs; a job waits for its game (the scoreboard) and a
/// channel carrying it (the plugin's game↔channel matching), records the channel's continuous playlist into a work
/// folder, stops when the game is final plus the post-roll (or at the maximum length, the free-space reserve, or on
/// cancel), then remuxes the segments into one file with an NFO and art and adds it to the library that covers the
/// recordings folder.
/// A loop every few seconds drives it while there is anything to do; recordings resume after a restart.
/// </summary>
public sealed class DvrService : IHostedService, IDisposable
{
    public const string LibraryName = "Sports Recordings";
    private const int LookAheadDays = 7;
    private static readonly TimeSpan SwitchChannelAfter = TimeSpan.FromSeconds(60);

    private readonly SourceManager _sources;
    private readonly ScoreboardService _scoreboard;
    private readonly LiveLadderService _ladder;
    private readonly ProxyCache _cache;
    private readonly GameArtService _gameArt;
    private readonly CardArtService _cardArt;
    private readonly IMediaEncoder _encoder;
    private readonly ILibraryManager _library;
    private readonly IFileSystem _fileSystem;
    private readonly ISessionManager _sessions;
    private readonly IApplicationPaths _paths;
    private readonly ILogger<DvrService> _logger;
    private readonly RecordingFinisher _finisher;

    private readonly object _gate = new();
    private readonly ConcurrentDictionary<Guid, ActiveRecording> _active = new();
    private volatile Dictionary<string, string> _carrying = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _wake = new(0);
    private readonly HashSet<Guid> _justResumed = new();
    private readonly SemaphoreSlim _libraryGate = new(1, 1);
    private DvrStore? _store;
    private DvrState _state = new();
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private DateTimeOffset _lastRetention = DateTimeOffset.MinValue;
    private DateTimeOffset _lastItemLookup = DateTimeOffset.MinValue;
    private bool _dirty;

    public DvrService(
        SourceManager sources,
        ScoreboardService scoreboard,
        LiveLadderService ladder,
        ProxyCache cache,
        GameArtService gameArt,
        CardArtService cardArt,
        IMediaEncoder encoder,
        ILibraryManager library,
        IFileSystem fileSystem,
        ISessionManager sessions,
        IApplicationPaths paths,
        ILogger<DvrService> logger)
    {
        _sources = sources;
        _scoreboard = scoreboard;
        _ladder = ladder;
        _cache = cache;
        _gameArt = gameArt;
        _cardArt = cardArt;
        _encoder = encoder;
        _library = library;
        _fileSystem = fileSystem;
        _sessions = sessions;
        _paths = paths;
        _logger = logger;
        _finisher = new RecordingFinisher(() => Safe(() => encoder.EncoderPath), () => Safe(() => encoder.ProbePath), logger);
    }

    private static string? Safe(Func<string?> f)
    {
        try
        {
            return f();
        }
        catch (Exception)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ lifecycle

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var dataFolder = Plugin.Instance?.DataFolderPath ?? Path.Combine(_paths.PluginConfigurationsPath, "Jellyfin.Plugin.JellyTV");
        _store = new DvrStore(Path.Combine(dataFolder, "dvr"), _logger);
        lock (_gate)
        {
            _state = _store.Load();
        }

        _library.ItemAdded += OnItemAdded;
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => LoopAsync(_cts.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _library.ItemAdded -= OnItemAdded;
        _cts?.Cancel();
        // recordings are left "recording" on purpose: they pick up where they were after the restart
        var tasks = _active.Values.Select(a => a.Task).Where(t => t != null).Cast<Task>().ToList();
        if (_loop != null)
        {
            tasks.Add(_loop);
        }

        try
        {
            await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(10), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
        }

        Save(force: true);
    }

    public void Dispose()
    {
        _cts?.Dispose();
        _wake.Dispose();
        _libraryGate.Dispose();
    }

    private void Wake()
    {
        try
        {
            _wake.Release();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        await ResumeAsync(ct).ConfigureAwait(false);
        while (!ct.IsCancellationRequested)
        {
            var busy = false;
            try
            {
                busy = await TickAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "JellyTV DVR: tick failed");
            }

            Save();
            try
            {
                await _wake.WaitAsync(busy ? TimeSpan.FromSeconds(5) : TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>After a restart: recordings carry on (a new part of the timeline, spliced on), remuxes start over.</summary>
    private Task ResumeAsync(CancellationToken ct)
    {
        List<RecordingJob> recording, finishing;
        lock (_gate)
        {
            recording = _state.Jobs.Where(j => j.State == JobState.Recording).ToList();
            finishing = _state.Jobs.Where(j => j.State == JobState.Finishing).ToList();
        }

        foreach (var job in recording.Concat(finishing))
        {
            if (string.IsNullOrEmpty(job.WorkDir) || !Directory.Exists(job.WorkDir))
            {
                Update(job, j =>
                {
                    j.State = JobState.Failed;
                    j.Reason = "The recording's work folder is gone";
                    j.EndedAt = DateTimeOffset.UtcNow;
                });
                continue;
            }

            if (job.State == JobState.Finishing)
            {
                _logger.LogInformation("JellyTV DVR: {Title}: finishing again after a restart", job.Game.Title);
                StartRecorder(job, resume: true, finishOnly: true, ct);
            }
            else
            {
                _logger.LogInformation("JellyTV DVR: {Title}: resuming the recording after a restart", job.Game.Title);
                Update(job, j =>
                {
                    j.Resumes++;
                    _justResumed.Add(j.Id);
                });
                StartRecorder(job, resume: true, finishOnly: false, ct);
            }
        }

        return Task.CompletedTask;
    }

    // ------------------------------------------------------------------ the loop

    /// <summary>One pass: refresh games, make jobs for rules, move every job along. True while anything is active.</summary>
    private async Task<bool> TickAsync(CancellationToken ct)
    {
        List<RecordingRule> rules;
        List<RecordingJob> open;
        DvrSettings settings;
        lock (_gate)
        {
            rules = _state.Rules.ToList();
            open = _state.Jobs.Where(j => !JobState.IsFinal(j.State)).ToList();
            settings = _state.Settings;
        }

        var now = DateTimeOffset.UtcNow;
        if (now - _lastRetention > TimeSpan.FromHours(1))
        {
            _lastRetention = now;
            ApplyRetention();
        }

        if (now - _lastItemLookup > TimeSpan.FromMinutes(5))
        {
            _lastItemLookup = now;
            LookUpLibraryItems();
        }

        if (rules.Count == 0 && open.Count == 0)
        {
            return false;
        }

        if (!(Plugin.Instance?.Configuration.ScoresEnabled ?? true))
        {
            foreach (var job in open.Where(j => JobState.IsPending(j.State)))
            {
                Update(job, j => j.Reason = "Live scores are switched off: the DVR follows games by the scoreboard");
            }

            return open.Any(j => j.State == JobState.Recording);
        }

        var games = await AllGamesAsync(rules, open, ct).ConfigureAwait(false);
        MakeJobs(rules, games, now);
        MatchChannels(games);
        var byId = games.GroupBy(g => g.Id, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        lock (_gate)
        {
            open = _state.Jobs.Where(j => !JobState.IsFinal(j.State)).OrderBy(j => j.Game.Start).ToList();
        }

        var running = open.Count(j => j.State == JobState.Recording);
        var disk = open.Any(j => JobState.IsPending(j.State)) ? DiskSpace.For(RecordingsFolder(settings)) : null;
        foreach (var job in open)
        {
            byId.TryGetValue(job.Game.Id, out var game);
            if (game != null)
            {
                Update(job, j =>
                {
                    j.Game.Start = game.Start;
                    if (game.Broadcasts.Count > 0)
                    {
                        j.Game.Broadcasts = game.Broadcasts.ToList();
                    }

                    var firstLookSinceRestart = _justResumed.Remove(j.Id);
                    if (game.State == "post" && !game.IsCalledOff && j.FinalSeenAt == null && j.State == JobState.Recording)
                    {
                        if (firstLookSinceRestart)
                        {
                            // the game ended while the server was down: what comes now is not the game, stop with what there is
                            j.FinalSeenAt = now - TimeSpan.FromMinutes(settings.PostRollMinutes);
                            j.StopReason = "restart";
                        }
                        else
                        {
                            j.FinalSeenAt = now;
                        }
                    }
                });
            }

            var channel = game == null ? null : CarryingChannel(game.Id);
            var space = JobState.IsPending(job.State) && disk != null ? SpaceFor(job, game, channel, disk, settings, now) : null;
            var decision = DvrPolicy.Evaluate(job, game == null ? null : GameStatus.From(game), channel != null, running, settings, now, space);
            switch (decision.Action)
            {
                case DvrAction.StartRecording:
                    if (StartRecording(job, channel!, settings, ct))
                    {
                        running++;
                    }

                    break;
                case DvrAction.StopRecording:
                    if (_active.TryGetValue(job.Id, out var active))
                    {
                        active.RequestStop(decision.StopReason);
                    }

                    break;
                case DvrAction.Cancel:
                case DvrAction.Fail:
                    _logger.LogInformation("JellyTV DVR: {Title}: {State}: {Reason}", job.Game.Title, decision.State, decision.Reason);
                    Update(job, j =>
                    {
                        j.State = decision.State;
                        j.Reason = decision.Reason;
                        j.EndedAt = now;
                    });
                    break;
                default:
                    if (JobState.IsPending(job.State) && (job.State != decision.State || job.Reason != decision.Reason))
                    {
                        Update(job, j =>
                        {
                            j.State = decision.State;
                            j.Reason = decision.Reason;
                        });
                    }

                    break;
            }
        }

        return open.Any(j => j.State is JobState.Recording or JobState.Waiting or JobState.Finishing
                             || (j.State == JobState.Scheduled && j.Game.Start - now < TimeSpan.FromMinutes(30)));
    }

    /// <summary>Today's board, plus the next days' games in the leagues team rules look at, and of jobs whose game is
    /// not on today's board (a game scheduled days ahead).</summary>
    private async Task<List<GameInfo>> AllGamesAsync(List<RecordingRule> rules, List<RecordingJob> open, CancellationToken ct)
    {
        var games = new List<GameInfo>();
        try
        {
            games = await _scoreboard.GetGamesAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogInformation("JellyTV DVR: scoreboard unavailable: {Message}", ex.Message);
        }

        var teamRules = rules.Where(r => r.Kind == RecordingRule.TeamKind).ToList();
        var onBoard = games.Select(g => g.Id).ToHashSet(StringComparer.Ordinal);
        var ahead = open.Where(j => !onBoard.Contains(j.Game.Id)).Select(j => j.Game.LeaguePath).ToList();
        if (teamRules.Count > 0 || ahead.Count > 0)
        {
            var configured = ScoreboardService.ParseLeagues(Plugin.Instance?.Configuration.ScoreLeagues);
            var leagues = teamRules.Any(r => string.IsNullOrEmpty(r.LeaguePath))
                ? configured
                : configured.Where(l => teamRules.Any(r => string.Equals(r.LeaguePath, l, StringComparison.OrdinalIgnoreCase))
                                        || ahead.Contains(l, StringComparer.OrdinalIgnoreCase)).ToList();
            try
            {
                var seen = games.Select(g => g.Id).ToHashSet(StringComparer.Ordinal);
                var upcoming = await _scoreboard.GetUpcomingAsync(leagues, LookAheadDays, ct).ConfigureAwait(false);
                games.AddRange(upcoming.Where(g => seen.Add(g.Id)));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _logger.LogInformation("JellyTV DVR: upcoming games unavailable: {Message}", ex.Message);
            }
        }

        return games;
    }

    /// <summary>A job for every game a team rule covers (upcoming or live), once per game.</summary>
    private void MakeJobs(List<RecordingRule> rules, List<GameInfo> games, DateTimeOffset now)
    {
        var made = false;
        lock (_gate)
        {
            foreach (var rule in rules.Where(r => r.Kind == RecordingRule.TeamKind))
            {
                foreach (var g in games.Where(g => g.State != "post" && !g.IsCalledOff && rule.Covers(g)))
                {
                    if (_state.Jobs.Any(j => j.Game.Id == g.Id && (j.RuleId == rule.Id || !JobState.IsFinal(j.State) || j.State == JobState.Done)))
                    {
                        continue; // one recording per game
                    }

                    _state.Jobs.Add(NewJob(rule, g, now));
                    _logger.LogInformation("JellyTV DVR: {Rule}: scheduled {Title} ({Start:u})", rule.Title, GameSnapshot.From(g).Title, g.Start);
                    made = true;
                }
            }

            _dirty |= made;
        }
    }

    private static RecordingJob NewJob(RecordingRule rule, GameInfo g, DateTimeOffset now) => new()
    {
        RuleId = rule.Id,
        Game = GameSnapshot.From(g),
        State = JobState.Scheduled,
        CreatedAt = now
    };

    /// <summary>What a job not started yet would take, estimated for when it would start: the carrying channel's probed
    /// bitrate (else a typical stream's, as a forecast only) × the rest of a typical game from the pre-roll on.</summary>
    private SpaceCheck SpaceFor(RecordingJob job, GameInfo? game, SourceChannel? channel, DiskSpace.Info disk, DvrSettings settings, DateTimeOffset now)
    {
        var bitrate = channel == null ? null : KnownBitrate(channel);
        var left = DvrSpace.TimeLeft(job.Game.LeaguePath, game?.Start ?? job.Game.Start, game?.State ?? "pre", now, TimeSpan.FromMinutes(settings.PostRollMinutes));
        return new SpaceCheck(DvrSpace.Estimate(bitrate ?? DvrSpace.DefaultBitrate, left), disk.FreeBytes, settings.ReserveBytes, bitrate != null);
    }

    /// <summary>Which channel carries each game right now (the same choice the board's Watch makes).</summary>
    private void MatchChannels(List<GameInfo> games)
    {
        var channels = _sources.GetChannels();
        var probes = channels.Select(c => new ChannelProbe(c.Id, c.Name, _sources.GetNowNext(c.Id).Now?.Title)).ToList();
        GameChannelMatcher.Match(games, probes);
        var exists = channels.Select(c => c.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var carrying = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var g in games)
        {
            var pick = WatchResolver.Resolve(g, games, exists.Contains);
            if (pick != null)
            {
                carrying[g.Id] = pick.Id;
            }
        }

        _carrying = carrying; // swapped whole: recorders read it between ticks
    }

    private SourceChannel? CarryingChannel(string gameId)
        => _carrying.TryGetValue(gameId, out var id) ? _sources.GetChannel(id) : null;

    /// <summary>The channel a recording follows: the one it started on while it exists (and delivers), else whichever
    /// carries the game now.</summary>
    private SourceChannel? RecordingChannel(RecordingJob job, bool starving)
    {
        SourceChannel? current = null;
        if (!string.IsNullOrEmpty(job.ChannelId))
        {
            current = _sources.GetChannel(job.ChannelId) ?? (_sources.ResolveId(job.ChannelId) is { } id ? _sources.GetChannel(id) : null);
        }

        var carrying = CarryingChannel(job.Game.Id);
        if (current == null || (starving && carrying != null && carrying.Id != current.Id))
        {
            return carrying ?? current;
        }

        return current;
    }

    // ------------------------------------------------------------------ recording

    /// <summary>Starts recording a job the policy let start (space included: see <see cref="SpaceFor"/>). A stream
    /// never probed is judged by its measured bitrate once the first segments are in.</summary>
    private bool StartRecording(RecordingJob job, SourceChannel channel, DvrSettings settings, CancellationToken ct)
    {
        var folder = RecordingsFolder(settings);
        try
        {
            Directory.CreateDirectory(folder);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Fail(job, "The recordings folder cannot be created: " + ex.Message);
            return false;
        }

        var work = Path.Combine(WorkFolder.ParentFor(folder), job.Id.ToString("N"));
        Update(job, j =>
        {
            j.State = JobState.Recording;
            j.Reason = null;
            j.StartedAt = DateTimeOffset.UtcNow;
            j.ChannelId = channel.Id;
            j.ChannelName = channel.Name;
            j.WorkDir = work;
        });
        _logger.LogInformation("JellyTV DVR: {Title}: recording {Channel} into {Work}", job.Game.Title, channel.Name, work);
        StartRecorder(job, resume: false, finishOnly: false, ct);
        Save(force: true);
        return true;
    }

    private void Fail(RecordingJob job, string reason)
    {
        _logger.LogInformation("JellyTV DVR: {Title}: failed: {Reason}", job.Game.Title, reason);
        Update(job, j =>
        {
            j.State = JobState.Failed;
            j.Reason = reason;
            j.EndedAt = DateTimeOffset.UtcNow;
        });
    }

    private double? KnownBitrate(SourceChannel channel)
    {
        var ranked = _ladder.RankedTiers(channel);
        foreach (var t in ranked)
        {
            if (_ladder.Probe(t.CandidateKey) is { Ok: true })
            {
                return t.MeasuredBitrate ?? (t.Bandwidth > 0 ? t.Bandwidth : null);
            }
        }

        return null;
    }

    private void StartRecorder(RecordingJob job, bool resume, bool finishOnly, CancellationToken ct)
    {
        var active = new ActiveRecording(job.Id, resume);
        if (!_active.TryAdd(job.Id, active))
        {
            return;
        }

        active.Task = Task.Run(async () =>
        {
            try
            {
                var work = WorkFolder.Open(job.WorkDir!);
                if (!finishOnly)
                {
                    await RecordAsync(job, work, active, ct).ConfigureAwait(false);
                }

                if (ct.IsCancellationRequested)
                {
                    return; // the server is stopping: carry on after the restart
                }

                if (active.Failure != null)
                {
                    work.Delete();
                    Fail(job, active.Failure);
                    return;
                }

                await FinishAsync(job, work, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "JellyTV DVR: {Title}: recording failed", job.Game.Title);
                Fail(job, "Recording failed: " + ex.Message);
            }
            finally
            {
                _active.TryRemove(job.Id, out _);
                Save(force: true);
                Wake();
            }
        }, CancellationToken.None);
    }

    /// <summary>Follows the channel and writes each new segment to the work folder until asked to stop.</summary>
    private async Task RecordAsync(RecordingJob job, WorkFolder work, ActiveRecording active, CancellationToken serverStopping)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(serverStopping, active.Stop.Token);
        var ct = linked.Token;
        var splicer = new RecordingSplicer();
        var existing = work.Segments;
        if (existing.Count > 0)
        {
            splicer.Resume(work.ReadSegment(existing[0]), work.ReadSegment(existing[^1]));
        }

        var spaceChecked = active.Resumed && existing.Count > 0;
        ISegmentFeed? feed = null;
        var breakNext = existing.Count > 0;
        var lastSegmentAt = DateTimeOffset.UtcNow;
        var lastError = string.Empty;
        while (!ct.IsCancellationRequested)
        {
            var settings = Settings;
            var folder = RecordingsFolder(settings);
            try
            {
                var starving = DateTimeOffset.UtcNow - lastSegmentAt > SwitchChannelAfter;
                var channel = RecordingChannel(job, starving);
                if (channel == null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                    continue;
                }

                if (feed == null || feed.ChannelId != channel.Id)
                {
                    if (feed != null)
                    {
                        _logger.LogInformation("JellyTV DVR: {Title}: continuing on {Channel}", job.Game.Title, channel.Name);
                        breakNext = true;
                    }

                    feed = LiveLadderService.Enabled ? new LadderFeed(_ladder, channel) : new PassthroughFeed(_ladder.Fetch, _cache, channel);
                    Update(job, j =>
                    {
                        j.ChannelId = channel.Id;
                        j.ChannelName = channel.Name;
                    });
                }
                else if (feed is LadderFeed lf)
                {
                    lf.Update(channel);
                }

                var segments = await feed.PollAsync(ct).ConfigureAwait(false);
                if (segments == null)
                {
                    feed = new PassthroughFeed(_ladder.Fetch, _cache, channel);
                    continue;
                }

                foreach (var s in segments)
                {
                    var bytes = splicer.Process(s.Bytes, s.Discontinuity || breakNext, out var spliced);
                    breakNext = false;
                    work.Append(bytes, s.Duration, !spliced);
                    lastSegmentAt = DateTimeOffset.UtcNow;
                }

                if (segments.Count > 0)
                {
                    var bytesSoFar = work.Bytes;
                    var seconds = work.Seconds;
                    Update(job, j =>
                    {
                        j.Bytes = bytesSoFar;
                        j.Seconds = seconds;
                        j.Segments = work.Segments.Count;
                        j.LastSegmentAt = lastSegmentAt;
                        j.Bitrate = seconds > 0 ? bytesSoFar * 8 / seconds : null;
                    });
                }

                // after a few segments, the measured bitrate × the time left must fit
                if (!spaceChecked && work.Seconds >= 12 && job.Bitrate is { } measured && DiskSpace.For(folder) is { } space)
                {
                    spaceChecked = true;
                    var left = DvrSpace.TimeLeft(job.Game.LeaguePath, job.Game.Start, job.Game.Start > DateTimeOffset.UtcNow ? "pre" : "in",
                        DateTimeOffset.UtcNow, TimeSpan.FromMinutes(settings.PostRollMinutes));
                    var estimate = DvrSpace.Estimate(measured, left);
                    if (!DvrSpace.Fits(space.FreeBytes + work.Bytes, estimate, settings.ReserveBytes))
                    {
                        active.Failure = DvrSpace.NotEnough(estimate, space.FreeBytes + work.Bytes, settings.ReserveBytes);
                        break;
                    }
                }

                if (DiskSpace.For(folder) is { } now && DvrSpace.BelowReserve(now.FreeBytes, settings.ReserveBytes))
                {
                    _logger.LogWarning("JellyTV DVR: {Title}: free space below the reserve ({Free}), stopping", job.Game.Title, DvrSpace.Size(now.FreeBytes));
                    active.RequestStop("disk");
                    break;
                }

                lastError = string.Empty;
                await Task.Delay(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (UnrecordableStreamException ex)
            {
                active.Failure = ex.Message;
                break;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                if (ex.Message != lastError)
                {
                    _logger.LogWarning("JellyTV DVR: {Title}: {Message}", job.Game.Title, ex.Message);
                    lastError = ex.Message;
                }

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        var total = work.Bytes;
        var secs = work.Seconds;
        Update(job, j =>
        {
            j.Bytes = total;
            j.Seconds = secs;
            j.Segments = work.Segments.Count;
            j.StopReason = active.StopReason ?? j.StopReason;
        });
    }

    // ------------------------------------------------------------------ finishing

    private async Task FinishAsync(RecordingJob job, WorkFolder work, CancellationToken ct)
    {
        var settings = Settings;
        Update(job, j => j.State = JobState.Finishing);
        Save(force: true);

        var segments = work.Segments;
        var inPlaceStarted = RecordingFinisher.IsInPlaceConcatStarted(work);
        if (segments.Count == 0 && !inPlaceStarted)
        {
            work.Delete();
            Fail(job, job.StopReason == "canceled" ? "Canceled before anything was recorded" : "Nothing was recorded: the stream never delivered a segment");
            return;
        }

        var folder = RecordingsFolder(settings);
        var leagueDir = Path.Combine(folder, DvrNaming.LeagueFolder(job.Game));
        Directory.CreateDirectory(leagueDir);
        var zone = TimeZoneInfo.Local;

        // a restart during the join: same name, carry on
        var baseName = job.FilePath != null && Path.GetDirectoryName(job.FilePath) == leagueDir
            ? Path.GetFileNameWithoutExtension(job.FilePath)
            : DvrNaming.Unique(leagueDir, DvrNaming.BaseName(job.Game, zone),
                p => new[] { ".mp4", ".mkv", ".ts", ".nfo" }.Any(ext => File.Exists(p + ext)));
        var basePath = Path.Combine(leagueDir, baseName);

        // the name is kept with the job, so a restart during this step finishes under the same name
        Update(job, j => j.FilePath = basePath + ".mp4");
        Save(force: true);

        // metadata and art first, so the scan finds everything at once
        await WriteMetadataAsync(job, basePath, zone, ct).ConfigureAwait(false);

        var bytes = segments.Sum(s => s.Bytes);
        var free = DiskSpace.For(folder)?.FreeBytes ?? long.MaxValue;
        var roomToRemux = DvrSpace.CanRemux(free, bytes, settings.ReserveBytes);
        string? final = null;
        string? note = null;
        if (!inPlaceStarted && roomToRemux)
        {
            final = await RemuxAsync(job, work, basePath, ct).ConfigureAwait(false);
            note = final == null ? "Saved as MPEG-TS: the remux did not work" : null;
        }

        if (final == null)
        {
            final = basePath + ".ts";
            Update(job, j => j.FilePath = final);
            Save(force: true);
            var inPlace = inPlaceStarted || !roomToRemux || !DvrSpace.CanRemux(free, bytes, 0);
            _logger.LogInformation("JellyTV DVR: {Title}: joining {Count} segments into {File}{How}", job.Game.Title, segments.Count, final, inPlace ? " in place" : string.Empty);
            RecordingFinisher.Concat(work, final, inPlace, ct);
            if (inPlace)
            {
                note = "Saved as MPEG-TS: not enough room to remux";
            }
        }

        var fileBytes = new FileInfo(final).Length;
        work.Delete();
        var reason = DvrPolicy.Describe(job.StopReason, settings);
        Update(job, j =>
        {
            j.State = JobState.Done;
            j.FilePath = final;
            j.FileBytes = fileBytes;
            j.EndedAt = DateTimeOffset.UtcNow;
            j.Reason = reason ?? note;
            j.WorkDir = null;
        });
        Save(force: true);
        _logger.LogInformation("JellyTV DVR: {Title}: done, {File} ({Size}), {How}", job.Game.Title, final, DvrSpace.Size(fileBytes), reason ?? note ?? "complete");

        await EnsureLibraryAsync(job, final).ConfigureAwait(false);
        await ScanAsync(job, final, ct).ConfigureAwait(false);
        ApplyRetention();
    }

    /// <summary>MP4 (or MKV when MP4 cannot hold the codecs), verified with ffprobe, moved into place. Null when
    /// neither worked (the caller then joins the segments as .ts).</summary>
    private async Task<string?> RemuxAsync(RecordingJob job, WorkFolder work, string basePath, CancellationToken ct)
    {
        foreach (var (format, ext) in new[] { ("mp4", ".mp4"), ("matroska", ".mkv") })
        {
            var tmp = Path.Combine(work.Path, "remux" + ext);
            var error = await _finisher.RemuxAsync(work, tmp, format, job.Game.Title, ct).ConfigureAwait(false);
            if (error == null)
            {
                var probe = await _finisher.ProbeAsync(tmp, ct).ConfigureAwait(false);
                var expected = work.Seconds;
                var hadVideo = work.Segments.Count > 0 && work.ReadSegment(work.Segments[0]) is { } first && TsSplicer.Analyze(first).Video != null;
                if (probe is { } p && p.Duration >= (expected * 0.97) - 10 && p.Duration <= (expected * 1.03) + 10 && (p.HasVideo || !hadVideo))
                {
                    var final = basePath + ext;
                    File.Move(tmp, final, overwrite: true);
                    _logger.LogInformation("JellyTV DVR: {Title}: remuxed to {Format} ({Duration:0}s of {Expected:0}s recorded)", job.Game.Title, format, p.Duration, expected);
                    return final;
                }

                error = probe is not { } got ? "ffprobe could not read the result"
                    : $"the result is {got.Duration:0}s long ({expected:0}s recorded){(got.HasVideo || !hadVideo ? string.Empty : " and has no video")}";
            }

            _logger.LogWarning("JellyTV DVR: {Title}: remux to {Format} failed: {Error}", job.Game.Title, format, error);
            TryDelete(tmp);
        }

        return null;
    }

    private async Task WriteMetadataAsync(RecordingJob job, string basePath, TimeZoneInfo zone, CancellationToken ct)
    {
        try
        {
            await File.WriteAllTextAsync(basePath + ".nfo", DvrNfo.Build(job.Game, zone), ct).ConfigureAwait(false);
            var game = job.Game.ToArtGame();
            var fanart = await _gameArt.RenderGameAsync(game, ct).ConfigureAwait(false);
            await File.WriteAllBytesAsync(basePath + "-backdrop.png", fanart, ct).ConfigureAwait(false);
            var (thumb, poster) = await _cardArt.RenderRecordingArtAsync(game, zone, ct).ConfigureAwait(false);
            await File.WriteAllBytesAsync(basePath + "-thumb.png", thumb, ct).ConfigureAwait(false);
            await File.WriteAllBytesAsync(basePath + "-poster.png", poster, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _logger.LogWarning("JellyTV DVR: {Title}: metadata not written: {Message}", job.Game.Title, ex.Message);
        }
    }

    /// <summary>
    /// Adds a finished recording to the library and notes its item: validates the nearest folder Jellyfin already has
    /// an item for (the league folder, else the library folder), within the library that covers the file. A library
    /// folder that was empty when its library was made has no item at all (Jellyfin skips empty library folders, and
    /// only a full library scan adds them later), so it is added first, the way Jellyfin does after a library change.
    /// </summary>
    private async Task ScanAsync(RecordingJob job, string file, CancellationToken ct)
    {
        try
        {
            var location = CoveringLocation(file);
            if (location == null)
            {
                _logger.LogInformation("JellyTV DVR: {Title}: no library covers {Folder}; the recording joins one once a library covers that folder",
                    job.Game.Title, Path.GetDirectoryName(file));
                return;
            }

            var folder = NearestFolderItem(file, location);
            if (folder == null)
            {
                _logger.LogInformation("JellyTV DVR: adding the library folder {Folder} to Jellyfin", location);
                await _library.ValidateTopLibraryFolders(ct).ConfigureAwait(false);
                folder = NearestFolderItem(file, location);
            }

            if (folder == null)
            {
                _logger.LogWarning("JellyTV DVR: {Title}: Jellyfin has no item for the library folder {Folder}; the recording appears after the next library scan",
                    job.Game.Title, location);
                return;
            }

            await folder.ValidateChildren(new Progress<double>(), new MetadataRefreshOptions(new DirectoryService(_fileSystem)), true, false, ct).ConfigureAwait(false);
            for (var i = 0; i < 12 && !ct.IsCancellationRequested; i++)
            {
                if (NoteItem(job, file))
                {
                    return;
                }

                await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            }

            _logger.LogWarning("JellyTV DVR: {Title}: {Folder} was scanned but {File} is not in the library", job.Game.Title, folder.Path, file);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogWarning("JellyTV DVR: {Title}: library scan failed: {Message}", job.Game.Title, ex.Message);
        }
    }

    /// <summary>The first finished recording that no library covers creates the "Sports Recordings" library, once (see
    /// <see cref="RecordingLibrary.AutoCreateOnceAsync"/>).</summary>
    private async Task EnsureLibraryAsync(RecordingJob job, string file)
    {
        await _libraryGate.WaitAsync().ConfigureAwait(false);
        try
        {
            var name = await RecordingLibrary.AutoCreateOnceAsync(
                () => CoveringLocation(file) != null,
                () =>
                {
                    lock (_gate)
                    {
                        return _state.LibraryAutoCreatedAt;
                    }
                },
                CreateLibraryAsync,
                at =>
                {
                    lock (_gate)
                    {
                        _state.LibraryAutoCreatedAt = at;
                        _dirty = true;
                    }

                    Save(force: true);
                }).ConfigureAwait(false);
            if (name != null)
            {
                _logger.LogInformation(
                    "JellyTV DVR: {Title}: no library covered {Folder}, so the DVR created the library {Name} for recordings (once: if it is removed, it is not created again)",
                    job.Game.Title, RecordingsFolder(), name);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            _logger.LogWarning("JellyTV DVR: {Title}: could not create the {Name} library: {Message}", job.Game.Title, LibraryName, ex.Message);
        }
        finally
        {
            _libraryGate.Release();
        }
    }

    /// <summary>The folder item nearest to <paramref name="file"/>, never above the library folder.</summary>
    private Folder? NearestFolderItem(string file, string location)
    {
        for (var dir = Path.GetDirectoryName(file); !string.IsNullOrEmpty(dir); dir = Path.GetDirectoryName(dir))
        {
            if (_library.FindByPath(dir, true) is Folder f)
            {
                return f;
            }

            if (Normalize(dir).Equals(location, PathComparison))
            {
                break;
            }
        }

        return null;
    }

    private bool NoteItem(RecordingJob job, string file)
    {
        if (_library.FindByPath(file, false) is not { } item)
        {
            return false;
        }

        SetItem(job, item);
        return true;
    }

    private void SetItem(RecordingJob job, BaseItem item)
    {
        var id = item.Id.ToString("N");
        if (job.ItemId == id)
        {
            return;
        }

        Update(job, j => j.ItemId = id);
        Save(force: true);
        _logger.LogInformation("JellyTV DVR: {Title}: in the library as {Item}", job.Game.Title, id);
    }

    /// <summary>Jellyfin added an item: if it is a finished recording's file (added by our scan, the real-time monitor
    /// or a library scan), the job notes it at once.</summary>
    private void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        try
        {
            var item = e.Item;
            if (item == null || item.IsFolder || string.IsNullOrEmpty(item.Path))
            {
                return;
            }

            RecordingJob? job;
            lock (_gate)
            {
                job = _state.Jobs.FirstOrDefault(j => j.ItemId == null && j.State is JobState.Done or JobState.Finishing
                    && string.Equals(j.FilePath, item.Path, PathComparison));
            }

            if (job != null)
            {
                SetItem(job, item);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "JellyTV DVR: looking up an added item failed");
        }
    }

    /// <summary>Finished recordings without a library item look for it again (a library made or a scan run since).</summary>
    private void LookUpLibraryItems()
    {
        List<RecordingJob> missing;
        lock (_gate)
        {
            missing = _state.Jobs.Where(j => j.State == JobState.Done && j.ItemId == null && !string.IsNullOrEmpty(j.FilePath)).ToList();
        }

        foreach (var job in missing)
        {
            ItemIdFor(job);
        }
    }

    /// <summary>The library item of a finished recording, found again if Jellyfin only picked the file up later.</summary>
    private string? ItemIdFor(RecordingJob job)
    {
        if (job.ItemId != null || job.State != JobState.Done || string.IsNullOrEmpty(job.FilePath))
        {
            return job.ItemId;
        }

        var item = _library.FindByPath(job.FilePath, false);
        if (item != null)
        {
            var id = item.Id.ToString("N");
            Update(job, j => j.ItemId = id);
            return id;
        }

        return null;
    }

    // ------------------------------------------------------------------ retention and deleting

    private void ApplyRetention()
    {
        List<RecordingJob> doomed;
        lock (_gate)
        {
            doomed = DvrRetention.Select(_state.Jobs, _state.Rules, _state.Settings.DeleteAfterDays, DateTimeOffset.UtcNow, IsBeingWatched);
        }

        foreach (var job in doomed)
        {
            _logger.LogInformation("JellyTV DVR: retention: deleting {File}", job.FilePath);
            DeleteFiles(job);
            lock (_gate)
            {
                _state.Jobs.Remove(job);
                _dirty = true;
            }
        }
    }

    private bool IsBeingWatched(RecordingJob job)
    {
        var itemId = ItemIdFor(job);
        return _sessions.Sessions.Any(s => s.NowPlayingItem is { } np
            && ((itemId != null && np.Id.ToString("N") == itemId)
                || (job.FilePath != null && string.Equals(np.Path, job.FilePath, StringComparison.OrdinalIgnoreCase))));
    }

    private void DeleteFiles(RecordingJob job)
    {
        if (string.IsNullOrEmpty(job.FilePath))
        {
            return;
        }

        var item = _library.FindByPath(job.FilePath, false);
        var basePath = Path.Combine(Path.GetDirectoryName(job.FilePath)!, Path.GetFileNameWithoutExtension(job.FilePath));
        foreach (var f in new[] { job.FilePath, basePath + ".nfo", basePath + "-poster.png", basePath + "-backdrop.png", basePath + "-thumb.png" })
        {
            TryDelete(f);
        }

        if (item != null)
        {
            try
            {
                _library.DeleteItem(item, new DeleteOptions { DeleteFileLocation = false });
            }
            catch (Exception ex)
            {
                _logger.LogInformation("JellyTV DVR: could not remove {Item} from the library: {Message}", item.Id, ex.Message);
            }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    // ------------------------------------------------------------------ state helpers

    private void Update(RecordingJob job, Action<RecordingJob> change)
    {
        lock (_gate)
        {
            change(job);
            _dirty = true;
        }
    }

    private void Save(bool force = false)
    {
        lock (_gate)
        {
            if (!_dirty && !force)
            {
                return;
            }

            _store?.Save(_state);
            _dirty = false;
        }
    }

    private static T Copy<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value))!;

    // ------------------------------------------------------------------ what the API and the board use

    public DvrSettings Settings
    {
        get
        {
            lock (_gate)
            {
                return Copy(_state.Settings);
            }
        }
    }

    public string DefaultFolder => Path.Combine(_paths.ProgramDataPath, "Tally Recordings");

    public string RecordingsFolder(DvrSettings? settings = null)
    {
        var folder = (settings ?? Settings).Folder;
        return string.IsNullOrWhiteSpace(folder) ? DefaultFolder : Path.GetFullPath(folder);
    }

    public DvrSettings SaveSettings(DvrSettings settings)
    {
        var s = settings.Normalized();
        lock (_gate)
        {
            _state.Settings = s;
            _dirty = true;
        }

        Save(force: true);
        Wake();
        return Copy(s);
    }

    public List<RecordingRule> Rules
    {
        get
        {
            lock (_gate)
            {
                return Copy(_state.Rules);
            }
        }
    }

    public List<RecordingJob> Jobs
    {
        get
        {
            List<RecordingJob> jobs;
            lock (_gate)
            {
                jobs = Copy(_state.Jobs);
            }

            foreach (var j in jobs.Where(j => j.State == JobState.Done && j.ItemId == null))
            {
                j.ItemId = ItemIdFor(FindJob(j.Id) ?? j);
            }

            return jobs;
        }
    }

    private RecordingJob? FindJob(Guid id)
    {
        lock (_gate)
        {
            return _state.Jobs.FirstOrDefault(j => j.Id == id);
        }
    }

    /// <summary>Records one game. A game already scheduled or being recorded returns that job instead; a game whose
    /// recording was stopped (or failed) can be recorded again while it is still on (a second file, "… (2)").</summary>
    public (RecordingRule? Rule, RecordingJob Job, bool Created) RecordGame(GameInfo game, Guid userId, string userName)
    {
        var now = DateTimeOffset.UtcNow;
        lock (_gate)
        {
            var existing = _state.Jobs.FirstOrDefault(j => j.Game.Id == game.Id && !JobState.IsFinal(j.State));
            if (existing != null)
            {
                return (_state.Rules.FirstOrDefault(r => r.Id == existing.RuleId), Copy(existing), false);
            }

            var snapshot = GameSnapshot.From(game);
            var rule = new RecordingRule
            {
                Kind = RecordingRule.GameKind,
                LeaguePath = game.LeaguePath,
                GameId = game.Id,
                Title = snapshot.Title,
                CreatedBy = userId,
                CreatedByName = userName,
                CreatedAt = now
            };
            var job = NewJob(rule, game, now);
            _state.Rules.Add(rule);
            _state.Jobs.Add(job);
            _dirty = true;
            _logger.LogInformation("JellyTV DVR: {User} asked to record {Title}", userName, snapshot.Title);
            Save(force: true);
            Wake();
            return (Copy(rule), Copy(job), true);
        }
    }

    /// <summary>Records every game of a team (in one league, or any). The same team twice returns the first rule.</summary>
    public (RecordingRule Rule, bool Created) RecordTeam(GameTeam team, string leaguePath, int keepLast, Guid userId, string userName)
    {
        lock (_gate)
        {
            var existing = _state.Rules.FirstOrDefault(r => r.Kind == RecordingRule.TeamKind && r.TeamId == team.Id
                && string.Equals(r.LeaguePath, leaguePath, StringComparison.OrdinalIgnoreCase));
            if (existing != null)
            {
                existing.KeepLast = Math.Max(0, keepLast);
                _dirty = true;
                return (Copy(existing), false);
            }

            var name = !string.IsNullOrEmpty(team.Name) ? team.Name : team.ShortName;
            var rule = new RecordingRule
            {
                Kind = RecordingRule.TeamKind,
                LeaguePath = leaguePath,
                TeamId = team.Id,
                TeamName = name,
                Title = "Every " + name + " game",
                KeepLast = Math.Max(0, keepLast),
                CreatedBy = userId,
                CreatedByName = userName,
                CreatedAt = DateTimeOffset.UtcNow
            };
            _state.Rules.Add(rule);
            _dirty = true;
            _logger.LogInformation("JellyTV DVR: {User} asked to record {Title}", userName, rule.Title);
            Save(force: true);
            Wake();
            return (Copy(rule), true);
        }
    }

    /// <summary>Cancels a job: one not started yet is canceled; a recording stops and keeps what it has. Null on
    /// success, else why not.</summary>
    public string? CancelJob(Guid id)
    {
        var job = FindJob(id);
        if (job == null)
        {
            return "not found";
        }

        if (JobState.IsPending(job.State))
        {
            Update(job, j =>
            {
                j.State = JobState.Canceled;
                j.Reason = "Canceled";
                j.EndedAt = DateTimeOffset.UtcNow;
            });
            Save(force: true);
            return null;
        }

        if (job.State == JobState.Recording && _active.TryGetValue(id, out var active))
        {
            active.RequestStop("canceled");
            return null;
        }

        return job.State == JobState.Recording ? "The recording is starting up; try again in a moment" : "This job has already finished";
    }

    /// <summary>Deletes a rule; its jobs that have not started are canceled (recordings in progress go on).</summary>
    public bool DeleteRule(Guid id)
    {
        lock (_gate)
        {
            var rule = _state.Rules.FirstOrDefault(r => r.Id == id);
            if (rule == null)
            {
                return false;
            }

            _state.Rules.Remove(rule);
            foreach (var j in _state.Jobs.Where(j => j.RuleId == id && JobState.IsPending(j.State)))
            {
                j.State = JobState.Canceled;
                j.Reason = "Its rule was deleted";
                j.EndedAt = DateTimeOffset.UtcNow;
            }

            _dirty = true;
        }

        Save(force: true);
        return true;
    }

    /// <summary>Deletes a finished recording's file (and its NFO and art) and the library item. Null on success.</summary>
    public string? DeleteRecording(Guid id)
    {
        var job = FindJob(id);
        if (job == null)
        {
            return "not found";
        }

        if (!JobState.IsFinal(job.State))
        {
            return "The job is still running: cancel it first";
        }

        if (IsBeingWatched(job))
        {
            return "Someone is watching this recording";
        }

        DeleteFiles(job);
        lock (_gate)
        {
            _state.Jobs.Remove(job);
            _dirty = true;
        }

        Save(force: true);
        return null;
    }

    /// <summary>The work folder behind a start-over playlist, while the job is recording or finishing.</summary>
    public (WorkFolder Work, bool Ended)? StartOver(Guid jobId)
    {
        var job = FindJob(jobId);
        if (job == null || job.WorkDir == null || job.State is not (JobState.Recording or JobState.Finishing) || !Directory.Exists(job.WorkDir))
        {
            return null;
        }

        return (WorkFolder.Open(job.WorkDir), job.State != JobState.Recording);
    }

    /// <summary>What the board shows for a game: its most relevant job.</summary>
    /// <param name="gameId">Scoreboard event id.</param>
    /// <param name="startOverPath">Builds a job's signed start-over path.</param>
    /// <param name="libraryState">The job's library state (<see cref="LibraryStates"/>, shared by one board's games);
    /// null: looked up for this game alone.</param>
    public GameRecording? ForGame(string gameId, Func<Guid, string> startOverPath, Func<RecordingJob, string>? libraryState = null)
    {
        RecordingJob? job;
        lock (_gate)
        {
            job = _state.Jobs.Where(j => j.Game.Id == gameId)
                .OrderBy(j => JobState.IsFinal(j.State) ? 1 : 0)
                .ThenBy(j => j.State == JobState.Done ? 0 : 1)
                .ThenByDescending(j => j.CreatedAt)
                .FirstOrDefault();
        }

        if (job == null)
        {
            return null;
        }

        var itemId = ItemIdFor(job);
        return new GameRecording
        {
            State = job.State,
            JobId = job.Id.ToString("N"),
            StartOverPath = job.State == JobState.Recording && job.Segments > 0 ? startOverPath(job.Id) : null,
            ItemId = itemId,
            LibraryState = itemId != null ? RecordingLibrary.Ready : libraryState?.Invoke(job) ?? RecordingLibrary.State(null, IsCovered(job)),
            Reason = job.Reason
        };
    }

    public bool HasAnything
    {
        get
        {
            lock (_gate)
            {
                return _state.Jobs.Count > 0 || _state.Rules.Count > 0;
            }
        }
    }

    // ------------------------------------------------------------------ storage and library

    public sealed record Storage(string Folder, bool IsDefault, long? FreeBytes, long? TotalBytes, long UsedBytes, long ReserveBytes);

    public Storage GetStorage()
    {
        var settings = Settings;
        var folder = RecordingsFolder(settings);
        var space = DiskSpace.For(folder);
        long used = 0;
        lock (_gate)
        {
            used = _state.Jobs.Where(j => j.State == JobState.Done && j.FilePath != null && File.Exists(j.FilePath)).Sum(j => j.FileBytes)
                   + _state.Jobs.Where(j => j.State is JobState.Recording or JobState.Finishing).Sum(j => j.Bytes);
        }

        return new Storage(folder, string.IsNullOrWhiteSpace(settings.Folder), space?.FreeBytes, space?.TotalBytes, used, settings.ReserveBytes);
    }

    public sealed record Estimate(string GameId, long Bytes, double Bitrate, bool BitrateMeasured, double SecondsLeft, bool Fits, string? Message);

    /// <summary>How much recording this game would take from now, and whether it fits.</summary>
    public Estimate EstimateFor(GameInfo game)
    {
        var settings = Settings;
        double? bitrate;
        RecordingJob? job;
        lock (_gate)
        {
            job = _state.Jobs.FirstOrDefault(j => j.Game.Id == game.Id && j.State == JobState.Recording);
        }

        bitrate = job?.Bitrate;
        if (bitrate == null && _sources.GetChannels().Count > 0)
        {
            var games = new List<GameInfo> { game };
            var channels = _sources.GetChannels();
            GameChannelMatcher.Match(games, channels.Select(c => new ChannelProbe(c.Id, c.Name, _sources.GetNowNext(c.Id).Now?.Title)).ToList());
            var pick = WatchResolver.Resolve(game, games, id => _sources.GetChannel(id) != null);
            if (pick != null && _sources.GetChannel(pick.Id) is { } ch)
            {
                bitrate = KnownBitrate(ch);
            }
        }

        var left = DvrSpace.TimeLeft(game.LeaguePath, game.Start, game.State, DateTimeOffset.UtcNow, TimeSpan.FromMinutes(settings.PostRollMinutes));
        var bps = bitrate ?? DvrSpace.DefaultBitrate;
        var estimate = DvrSpace.Estimate(bps, left);
        var free = DiskSpace.For(RecordingsFolder(settings))?.FreeBytes ?? 0;
        var fits = DvrSpace.Fits(free, estimate, settings.ReserveBytes);
        return new Estimate(game.Id, estimate, bps, bitrate != null, left.TotalSeconds, fits, fits ? null : DvrSpace.EstimateMessage(game.State, estimate, free, settings.ReserveBytes));
    }

    /// <summary>The Jellyfin library whose folders include the recordings folder, if any.</summary>
    public string? CoveringLibrary() => Covering(RecordingsFolder())?.Library;

    /// <summary>Whether the DVR once created the recordings library by itself.</summary>
    public DateTimeOffset? LibraryAutoCreatedAt
    {
        get
        {
            lock (_gate)
            {
                return _state.LibraryAutoCreatedAt;
            }
        }
    }

    /// <summary>Whether a library covers the job's file (its planned place in the recordings folder until it has one).</summary>
    public bool IsCovered(RecordingJob job) => CoveringLocation(string.IsNullOrEmpty(job.FilePath) ? RecordingsFolder() : job.FilePath) != null;

    /// <summary>"ready", "adding" or "noLibrary" for each job, reading Jellyfin's libraries once.</summary>
    public Func<RecordingJob, string> LibraryStates()
    {
        var locations = _library.GetVirtualFolders().SelectMany(vf => vf.Locations ?? Array.Empty<string>()).Select(Normalize).ToList();
        var folder = RecordingsFolder();
        return job =>
        {
            if (!string.IsNullOrEmpty(job.ItemId))
            {
                return RecordingLibrary.Ready;
            }

            var p = Normalize(string.IsNullOrEmpty(job.FilePath) ? folder : job.FilePath);
            var covered = locations.Any(l => p.Equals(l, PathComparison) || p.StartsWith(l + Path.DirectorySeparatorChar, PathComparison));
            return RecordingLibrary.State(null, covered);
        };
    }

    /// <summary>The library folder (one of a library's locations) that holds <paramref name="path"/>, if any.</summary>
    private string? CoveringLocation(string path) => Covering(path)?.Location;

    /// <summary>The library and its folder holding <paramref name="path"/>: the deepest folder when several do.</summary>
    private (string Library, string Location)? Covering(string path)
    {
        var p = Normalize(path);
        (string Library, string Location)? best = null;
        foreach (var vf in _library.GetVirtualFolders())
        {
            foreach (var loc in vf.Locations ?? Array.Empty<string>())
            {
                var l = Normalize(loc);
                if ((p.Equals(l, PathComparison) || p.StartsWith(l + Path.DirectorySeparatorChar, PathComparison))
                    && (best == null || l.Length > best.Value.Location.Length))
                {
                    best = (vf.Name, l);
                }
            }
        }

        return best;
    }

    private static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static string Normalize(string p)
    {
        try
        {
            return Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return p;
        }
    }

    /// <summary>Creates the "Sports Recordings" library on the recordings folder: a Movies library (one video file per
    /// item, the NFO's title and date shown as is) with every internet metadata and image fetcher off and no NFO
    /// saver, so nothing replaces the recording's own NFO and art.</summary>
    public async Task<string> CreateLibraryAsync()
    {
        var folder = RecordingsFolder();
        Directory.CreateDirectory(folder);
        // Jellyfin skips a library folder that is empty and only adds it at the next full scan; the work folder (which
        // its scanner ignores) keeps it from being empty, so the library is complete from the start
        WorkFolder.EnsureParent(WorkFolder.ParentFor(folder));
        var name = LibraryName;
        var names = _library.GetVirtualFolders().Select(v => v.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        for (var n = 2; names.Contains(name); n++)
        {
            name = $"{LibraryName} {n}";
        }

        var options = new LibraryOptions
        {
            PathInfos = new[] { new MediaPathInfo { Path = folder } },
            EnableRealtimeMonitor = true,
            SaveLocalMetadata = false,
            MetadataSavers = Array.Empty<string>(),
            EnableEmbeddedTitles = false,
            TypeOptions = new[]
            {
                new TypeOptions
                {
                    Type = "Movie",
                    MetadataFetchers = Array.Empty<string>(),
                    MetadataFetcherOrder = Array.Empty<string>(),
                    ImageFetchers = Array.Empty<string>(),
                    ImageFetcherOrder = Array.Empty<string>()
                }
            }
        };
        await _library.AddVirtualFolder(name, CollectionTypeOptions.movies, options, true).ConfigureAwait(false);
        _logger.LogInformation("JellyTV DVR: created the library {Name} on {Folder}", name, folder);
        return name;
    }

    /// <summary>A recording running (or being finished) now.</summary>
    private sealed class ActiveRecording
    {
        public ActiveRecording(Guid id, bool resumed)
        {
            Id = id;
            Resumed = resumed;
            StartedAt = DateTimeOffset.UtcNow;
        }

        public Guid Id { get; }

        public bool Resumed { get; }

        public DateTimeOffset StartedAt { get; }

        public CancellationTokenSource Stop { get; } = new();

        public string? StopReason { get; private set; }

        /// <summary>Set when the recording must be thrown away (not enough space, a format that cannot be recorded).</summary>
        public string? Failure { get; set; }

        public Task? Task { get; set; }

        public void RequestStop(string? reason)
        {
            StopReason ??= reason;
            Stop.Cancel();
        }
    }
}
