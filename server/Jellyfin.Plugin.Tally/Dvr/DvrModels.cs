using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Tally.Scores;

namespace Jellyfin.Plugin.Tally.Dvr;

/// <summary>Where a recording job is. Scheduled (game upcoming) → waiting (for a stream, or a free slot) → recording →
/// finishing (remux) → done, failed (with a plain reason) or canceled.</summary>
public static class JobState
{
    public const string Scheduled = "scheduled";
    public const string Waiting = "waiting";
    public const string Recording = "recording";
    public const string Finishing = "finishing";
    public const string Done = "done";
    public const string Failed = "failed";
    public const string Canceled = "canceled";

    public static bool IsFinal(string state) => state is Done or Failed or Canceled;

    /// <summary>Not started yet: canceling it records nothing.</summary>
    public static bool IsPending(string state) => state is Scheduled or Waiting;
}

/// <summary>DVR settings, server-wide. Kept in the DVR's own file (not the plugin configuration), so the settings
/// page's configuration save can never write back stale DVR values.</summary>
public sealed class DvrSettings
{
    public const long Gb = 1024L * 1024 * 1024;

    /// <summary>Recordings folder; empty = a "Tally Recordings" folder next to Jellyfin's data folder.</summary>
    [JsonPropertyName("folder")] public string Folder { get; set; } = string.Empty;

    /// <summary>Free space to leave on the recordings drive: a recording does not start, and stops, below it.</summary>
    [JsonPropertyName("reserveBytes")] public long ReserveBytes { get; set; } = 10 * Gb;

    [JsonPropertyName("maxConcurrent")] public int MaxConcurrent { get; set; } = 3;

    /// <summary>Minutes recorded after the scoreboard says the game is final.</summary>
    [JsonPropertyName("postRollMinutes")] public int PostRollMinutes { get; set; } = 5;

    [JsonPropertyName("maxHours")] public double MaxHours { get; set; } = 6;

    /// <summary>Delete recordings this many days after they were recorded; 0 = never.</summary>
    [JsonPropertyName("deleteAfterDays")] public int DeleteAfterDays { get; set; }

    public DvrSettings Normalized()
    {
        return new DvrSettings
        {
            Folder = (Folder ?? string.Empty).Trim(),
            ReserveBytes = Math.Clamp(ReserveBytes, 0, 100_000 * Gb),
            MaxConcurrent = Math.Clamp(MaxConcurrent, 1, 20),
            PostRollMinutes = Math.Clamp(PostRollMinutes, 0, 120),
            MaxHours = Math.Clamp(MaxHours, 0.25, 24),
            DeleteAfterDays = Math.Clamp(DeleteAfterDays, 0, 3650)
        };
    }
}

/// <summary>One side of a recorded game, as the recording remembers it. Deliberately without a score: nothing the
/// DVR writes (job file, file name, NFO, art) can carry the result.</summary>
public sealed class TeamSnapshot
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;

    [JsonPropertyName("abbr")] public string Abbr { get; set; } = string.Empty;

    [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;

    [JsonPropertyName("shortName")] public string ShortName { get; set; } = string.Empty;

    [JsonPropertyName("nickname")] public string Nickname { get; set; } = string.Empty;

    [JsonPropertyName("location")] public string Location { get; set; } = string.Empty;

    [JsonPropertyName("logo")] public string Logo { get; set; } = string.Empty;

    [JsonPropertyName("color")] public string Color { get; set; } = string.Empty;

    [JsonPropertyName("altColor")] public string AltColor { get; set; } = string.Empty;

    public static TeamSnapshot From(GameTeam t) => new()
    {
        Id = t.Id, Abbr = t.Abbr, Name = t.Name, ShortName = t.ShortName, Nickname = t.Nickname,
        Location = t.Location, Logo = t.Logo, Color = t.Color, AltColor = t.AltColor
    };

    public GameTeam ToTeam() => new()
    {
        Id = Id, Abbr = Abbr, Name = Name, ShortName = ShortName, Nickname = Nickname,
        Location = Location, Logo = Logo, Color = Color, AltColor = AltColor
    };

    /// <summary>The name a title uses: the full name, else the short one, else the abbreviation.</summary>
    [JsonIgnore]
    public string DisplayName => !string.IsNullOrWhiteSpace(Name) ? Name : !string.IsNullOrWhiteSpace(ShortName) ? ShortName : Abbr;
}

/// <summary>The game a job records, frozen when the job was made and refreshed from the scoreboard while it runs
/// (start time, teams), never with a score.</summary>
public sealed class GameSnapshot
{
    [JsonPropertyName("id")] public string Id { get; set; } = string.Empty;

    [JsonPropertyName("leaguePath")] public string LeaguePath { get; set; } = string.Empty;

    [JsonPropertyName("league")] public string League { get; set; } = string.Empty;

    [JsonPropertyName("sport")] public string Sport { get; set; } = string.Empty;

    [JsonPropertyName("start")] public DateTimeOffset Start { get; set; }

    [JsonPropertyName("away")] public TeamSnapshot Away { get; set; } = new();

    [JsonPropertyName("home")] public TeamSnapshot Home { get; set; } = new();

    [JsonPropertyName("broadcasts")] public List<string> Broadcasts { get; set; } = new();

    /// <summary>"Away at Home".</summary>
    [JsonPropertyName("title")] public string Title => $"{Away.DisplayName} at {Home.DisplayName}";

    public static GameSnapshot From(GameInfo g) => new()
    {
        Id = g.Id,
        LeaguePath = g.LeaguePath,
        League = g.League,
        Sport = g.Sport,
        Start = g.Start,
        Away = TeamSnapshot.From(g.Away),
        Home = TeamSnapshot.From(g.Home),
        Broadcasts = g.Broadcasts.ToList()
    };

    /// <summary>A scoreless, not-yet-started game for the art renderers.</summary>
    public GameInfo ToArtGame() => new()
    {
        Id = Id, League = League, Sport = Sport, Start = Start, State = "pre", LeaguePath = LeaguePath,
        Away = Away.ToTeam(), Home = Home.ToTeam(), Broadcasts = Broadcasts.ToList(), Name = Title
    };
}

/// <summary>What to record: one game, or every game of a team (optionally in one league). Server-wide.</summary>
public sealed class RecordingRule
{
    public const string GameKind = "game";
    public const string TeamKind = "team";

    [JsonPropertyName("id")] public Guid Id { get; set; } = Guid.NewGuid();

    [JsonPropertyName("kind")] public string Kind { get; set; } = GameKind;

    /// <summary>Game rules: the game's league; team rules: the league it is limited to, empty = any league.</summary>
    [JsonPropertyName("leaguePath")] public string LeaguePath { get; set; } = string.Empty;

    [JsonPropertyName("gameId")] public string? GameId { get; set; }

    [JsonPropertyName("teamId")] public string? TeamId { get; set; }

    [JsonPropertyName("teamName")] public string? TeamName { get; set; }

    [JsonPropertyName("title")] public string Title { get; set; } = string.Empty;

    /// <summary>Team rules: keep the last N recorded games, 0 = all.</summary>
    [JsonPropertyName("keepLast")] public int KeepLast { get; set; }

    [JsonPropertyName("createdBy")] public Guid CreatedBy { get; set; }

    [JsonPropertyName("createdByName")] public string CreatedByName { get; set; } = string.Empty;

    [JsonPropertyName("createdAt")] public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Team rules: this game is one of the team's (in the rule's league, if it has one).</summary>
    public bool Covers(GameInfo g)
        => Kind == TeamKind
           && !string.IsNullOrEmpty(TeamId)
           && (string.IsNullOrEmpty(LeaguePath) || string.Equals(LeaguePath, g.LeaguePath, StringComparison.OrdinalIgnoreCase))
           && (g.Home.Id == TeamId || g.Away.Id == TeamId);
}

/// <summary>One game being (or to be, or that was) recorded.</summary>
public sealed class RecordingJob
{
    [JsonPropertyName("id")] public Guid Id { get; set; } = Guid.NewGuid();

    [JsonPropertyName("ruleId")] public Guid RuleId { get; set; }

    [JsonPropertyName("game")] public GameSnapshot Game { get; set; } = new();

    [JsonPropertyName("state")] public string State { get; set; } = JobState.Scheduled;

    /// <summary>Why it is waiting, why it failed, or why it stopped early.</summary>
    [JsonPropertyName("reason")] public string? Reason { get; set; }

    /// <summary>Set when a recording stopped before the game's end: "canceled", "disk", "maxLength", "postponed".</summary>
    [JsonPropertyName("stopReason")] public string? StopReason { get; set; }

    [JsonPropertyName("createdAt")] public DateTimeOffset CreatedAt { get; set; }

    [JsonPropertyName("startedAt")] public DateTimeOffset? StartedAt { get; set; }

    [JsonPropertyName("endedAt")] public DateTimeOffset? EndedAt { get; set; }

    /// <summary>When the scoreboard first said the game was final (the post-roll counts from here).</summary>
    [JsonPropertyName("finalSeenAt")] public DateTimeOffset? FinalSeenAt { get; set; }

    [JsonPropertyName("channelId")] public string? ChannelId { get; set; }

    [JsonPropertyName("channelName")] public string? ChannelName { get; set; }

    [JsonPropertyName("bytes")] public long Bytes { get; set; }

    [JsonPropertyName("seconds")] public double Seconds { get; set; }

    [JsonPropertyName("segments")] public int Segments { get; set; }

    /// <summary>Measured bits per second of what was recorded.</summary>
    [JsonPropertyName("bitrate")] public double? Bitrate { get; set; }

    [JsonPropertyName("lastSegmentAt")] public DateTimeOffset? LastSegmentAt { get; set; }

    /// <summary>How many times the recording was picked up again after a server restart.</summary>
    [JsonPropertyName("resumes")] public int Resumes { get; set; }

    /// <summary>The finished file.</summary>
    [JsonPropertyName("filePath")] public string? FilePath { get; set; }

    [JsonPropertyName("fileBytes")] public long FileBytes { get; set; }

    /// <summary>The Jellyfin library item of the finished file, once Jellyfin has scanned it.</summary>
    [JsonPropertyName("itemId")] public string? ItemId { get; set; }

    [JsonPropertyName("workDir")] public string? WorkDir { get; set; }
}

/// <summary>Everything the DVR keeps on disk.</summary>
public sealed class DvrState
{
    [JsonPropertyName("settings")] public DvrSettings Settings { get; set; } = new();

    [JsonPropertyName("rules")] public List<RecordingRule> Rules { get; set; } = new();

    [JsonPropertyName("jobs")] public List<RecordingJob> Jobs { get; set; } = new();

    /// <summary>When the DVR created the recordings library by itself (the first finished recording without one). Set
    /// once and never cleared: a library the owner removes afterwards is not created again.</summary>
    [JsonPropertyName("libraryAutoCreatedAt")] public DateTimeOffset? LibraryAutoCreatedAt { get; set; }
}

/// <summary>A game's recording as the board shows it.</summary>
public sealed class GameRecording
{
    [JsonPropertyName("state")] public string State { get; set; } = string.Empty;

    [JsonPropertyName("jobId")] public string JobId { get; set; } = string.Empty;

    /// <summary>Root-relative, signed HLS of everything recorded so far (EVENT playlist), while recording.</summary>
    [JsonPropertyName("startOverPath")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StartOverPath { get; set; }

    /// <summary>The library item of the finished recording.</summary>
    [JsonPropertyName("itemId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ItemId { get; set; }

    /// <summary>"ready", "adding" or "noLibrary" (see <see cref="RecordingLibrary"/>).</summary>
    [JsonPropertyName("libraryState")] public string LibraryState { get; set; } = RecordingLibrary.NoLibrary;

    [JsonPropertyName("reason")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Reason { get; set; }
}
