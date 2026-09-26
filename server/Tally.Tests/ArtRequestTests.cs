using System.Text.Json;
using Jellyfin.Plugin.Tally.Dvr;
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using SkiaSharp;
using Xunit;

namespace Tally.Tests;

/// <summary>The art endpoints' <c>w</c> and <c>tz</c> (contracts 1 and 2 of 2.2).</summary>
public class ArtRequestTests
{
    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("abc", null)]
    [InlineData("0", null)]
    [InlineData("-300", null)]
    [InlineData("1", 320)]
    [InlineData("320", 320)]
    [InlineData("321", 480)]
    [InlineData(" 640 ", 640)]
    [InlineData("700", 960)]
    [InlineData("1000", 1280)]
    [InlineData("1400", null)]   // snaps to 1920: the backdrop's own size
    [InlineData("1920", null)]
    [InlineData("4000", null)]   // larger than every size: full size
    public void Backdrop_Width_Snaps_Up_To_The_Next_Size(string? w, int? expected)
        => Assert.Equal(expected, ArtRequest.SnapWidth(w, GameArtService.Width));

    [Theory]
    [InlineData("300", 320)]
    [InlineData("960", 960)]
    [InlineData("961", null)]   // snaps to 1280, the card's own size
    [InlineData("1280", null)]
    [InlineData("1400", null)]  // 1920 is larger than the card: full size
    public void Card_Width_Is_Never_Larger_Than_The_Card(string w, int? expected)
        => Assert.Equal(expected, ArtRequest.SnapWidth(w, CardArtService.Width));

    [Theory]
    [InlineData("America/New_York")]
    [InlineData("America/Los_Angeles")]
    [InlineData("Europe/Berlin")]
    [InlineData("Etc/GMT+5")]
    public void A_Known_Iana_Zone_Is_Used(string tz)
    {
        var zone = ArtRequest.Zone(tz);
        Assert.Equal(tz, zone.Id);
        Assert.NotSame(TimeZoneInfo.Local, zone);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("Mars/Olympus_Mons")]
    [InlineData("America/New York")]
    [InlineData("../../../etc/passwd")]
    [InlineData("America/../../etc/passwd")]
    [InlineData("A/very/long/zone/name/that/is/certainly/not/in/the/tz/database/anywhere/at/all")]
    public void A_Missing_Or_Unknown_Zone_Is_The_Servers_Own(string? tz)
        => Assert.Same(TimeZoneInfo.Local, ArtRequest.Zone(tz));

    [Fact]
    public void Card_Cache_Key_Has_The_Zone_And_Width_Of_A_Matchup_Card()
    {
        var ny = ArtRequest.Zone("America/New_York");
        var la = ArtRequest.Zone("America/Los_Angeles");
        var full = CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", ny, null);
        Assert.NotEqual(full, CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", la, null));
        Assert.NotEqual(full, CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", ny, 320));
        Assert.NotEqual(CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", ny, 320), CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", ny, 640));
        Assert.Equal(full, CardArtService.CacheKey("ch", "g1-pre", "Jets Packers", ArtRequest.Zone("America/New_York"), null));
        // a title card shows no time: one entry for every zone
        Assert.Equal(CardArtService.CacheKey("ch", "c", "Jets Packers", null, 320), CardArtService.CacheKey("ch", "c", "Jets Packers", null, 320));
    }

    [Fact]
    public void Backdrop_Cache_Key_Has_The_Width()
    {
        Assert.Equal("401", GameArtService.CacheKey("401", null));
        Assert.NotEqual(GameArtService.CacheKey("401", null), GameArtService.CacheKey("401", 320));
        Assert.NotEqual(GameArtService.CacheKey("401", 320), GameArtService.CacheKey("401", 640));
    }

    [Fact]
    public void Scaled_Art_Keeps_Its_Aspect_Ratio()
    {
        using var card = SKBitmap.Decode(ArtRequest.Scale(CardArtService.RenderTitle("Jets at Packers", "NFL"), 320));
        Assert.Equal(320, card.Width);
        Assert.Equal(180, card.Height);

        using var backdrop = SKBitmap.Decode(GameArtService.RenderPlain(480));
        Assert.Equal(480, backdrop.Width);
        Assert.Equal(270, backdrop.Height);
        Assert.Equal(SKColor.Parse("#0e0f0e"), backdrop.GetPixel(240, 135));

        using var full = SKBitmap.Decode(GameArtService.RenderPlain(null));
        Assert.Equal(GameArtService.Width, full.Width);
    }

    [Fact]
    public void Scaling_Never_Enlarges()
    {
        var png = CardArtService.RenderTitle("Jets at Packers", null);
        Assert.Same(png, ArtRequest.Scale(png, 1920));
    }

    [Fact]
    public void A_Card_Draws_Its_Times_In_The_Requested_Zone()
    {
        var game = new GameInfo
        {
            Id = "401", Sport = "football", League = "NFL", State = "pre",
            Start = new DateTimeOffset(2026, 9, 20, 23, 10, 0, TimeSpan.Zero),
            Home = new GameTeam { Abbr = "GB", ShortName = "Packers" },
            Away = new GameTeam { Abbr = "NYJ", ShortName = "Jets" }
        };
        var now = new DateTimeOffset(2026, 9, 20, 20, 0, 0, TimeSpan.Zero);
        var ny = CardArtService.RenderMatchup(game, null, null, ArtRequest.Zone("America/New_York"), now);
        var la = CardArtService.RenderMatchup(game, null, null, ArtRequest.Zone("America/Los_Angeles"), now);
        var la2 = CardArtService.RenderMatchup(game, null, null, ArtRequest.Zone("America/Los_Angeles"), now);
        Assert.NotEqual(ny, la);     // SUN 7:10 PM vs SUN 4:10 PM
        Assert.Equal(la, la2);
    }
}

/// <summary>Contract 3 of 2.2: <c>libraryState</c> and the recordings library the DVR creates once.</summary>
public class RecordingLibraryTests
{
    [Fact]
    public void Library_State_Follows_The_Item_Then_The_Library()
    {
        Assert.Equal("ready", RecordingLibrary.State("abc", covered: false));
        Assert.Equal("ready", RecordingLibrary.State("abc", covered: true));
        Assert.Equal("adding", RecordingLibrary.State(null, covered: true));
        Assert.Equal("adding", RecordingLibrary.State(string.Empty, covered: true));
        Assert.Equal("noLibrary", RecordingLibrary.State(null, covered: false));
    }

    [Fact]
    public void The_Board_Recording_Carries_Its_Library_State()
    {
        var json = JsonSerializer.Serialize(new GameRecording { State = "done", JobId = "j", LibraryState = RecordingLibrary.Adding });
        Assert.Contains("\"libraryState\":\"adding\"", json);
    }

    [Fact]
    public async Task The_Library_Is_Created_Once_And_Not_Again_After_The_Owner_Removes_It()
    {
        var libraries = new List<string>();
        DateTimeOffset? createdAt = null;
        var creates = 0;
        Task<string?> Finish() => RecordingLibrary.AutoCreateOnceAsync(
            () => libraries.Count > 0,
            () => createdAt,
            () =>
            {
                creates++;
                libraries.Add("Sports Recordings");
                return Task.FromResult("Sports Recordings");
            },
            at => createdAt = at);

        // first finished recording without a library: created
        Assert.Equal("Sports Recordings", await Finish());
        Assert.Equal(1, creates);
        Assert.NotNull(createdAt);

        // the next one: the library is there
        Assert.Null(await Finish());
        Assert.Equal(1, creates);

        // the owner removes it: not created again
        libraries.Clear();
        Assert.Null(await Finish());
        Assert.Equal(1, creates);
    }

    [Fact]
    public async Task A_Library_The_Owner_Made_Is_Left_Alone()
    {
        DateTimeOffset? createdAt = null;
        var created = await RecordingLibrary.AutoCreateOnceAsync(() => true, () => createdAt, () => throw new InvalidOperationException("must not create"), at => createdAt = at);
        Assert.Null(created);
        Assert.Null(createdAt);
    }

    [Fact]
    public async Task A_Failed_Creation_Is_Not_Remembered()
    {
        DateTimeOffset? createdAt = null;
        await Assert.ThrowsAsync<IOException>(() => RecordingLibrary.AutoCreateOnceAsync(() => false, () => createdAt, () => throw new IOException("disk"), at => createdAt = at));
        Assert.Null(createdAt);
    }

    [Fact]
    public void The_Created_Mark_Survives_A_Restart()
    {
        var at = new DateTimeOffset(2026, 9, 25, 12, 0, 0, TimeSpan.Zero);
        var json = JsonSerializer.Serialize(new DvrState { LibraryAutoCreatedAt = at });
        Assert.Contains("\"libraryAutoCreatedAt\"", json);
        Assert.Equal(at, JsonSerializer.Deserialize<DvrState>(json)!.LibraryAutoCreatedAt);
        Assert.Null(JsonSerializer.Deserialize<DvrState>("{\"jobs\":[]}")!.LibraryAutoCreatedAt);
    }
}
