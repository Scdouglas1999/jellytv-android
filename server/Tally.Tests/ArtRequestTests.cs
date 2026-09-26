using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.Tally.Dvr;
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging.Abstractions;
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
        // an item id with no library covering the file is a library that was removed: its items went with it
        Assert.Equal("noLibrary", RecordingLibrary.State("abc", covered: false));
        Assert.Equal("ready", RecordingLibrary.State("abc", covered: true));
        Assert.Equal("adding", RecordingLibrary.State(null, covered: true));
        Assert.Equal("adding", RecordingLibrary.State(string.Empty, covered: true));
        Assert.Equal("noLibrary", RecordingLibrary.State(null, covered: false));
    }

    [Fact]
    public void A_Recording_Keeps_Its_Item_Only_While_A_Library_Covers_It()
    {
        var found = 0;
        string? Find()
        {
            found++;
            return "new";
        }

        // library removed: no item, and nothing looked up (Jellyfin may still hand out the removed item from memory)
        Assert.Null(RecordingLibrary.Reconcile("old", covered: false, _ => true, Find));
        Assert.Equal(0, found);
        // library there, item there: kept
        Assert.Equal("old", RecordingLibrary.Reconcile("old", covered: true, _ => true, Find));
        Assert.Equal(0, found);
        // item deleted: looked up by the file again
        Assert.Equal("new", RecordingLibrary.Reconcile("old", covered: true, _ => false, Find));
        // no item yet (a library made since): looked up
        Assert.Equal("new", RecordingLibrary.Reconcile(null, covered: true, _ => throw new InvalidOperationException("no id to check"), Find));
        Assert.Null(RecordingLibrary.Reconcile(null, covered: true, _ => true, () => null));
    }

    [Fact]
    public void Removing_The_Recordings_Library_Frees_Its_Recordings()
    {
        // Jellyfin removes a library's items without an ItemRemoved for each (only for the library's folders), and
        // keeps handing out the removed items from memory: what counts is whether a library still covers the file
        var root = Path.Combine(Path.GetTempPath(), "tally-dvr-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(root, "MLB", "Riverton Otters at Lakeside Herons - 2026-09-26.mp4");
        var item = new Movie { Id = Guid.NewGuid(), Path = file };
        var library = FakeLibrary.Create(out var fake);
        fake.Folders.Add(new VirtualFolderInfo { Name = DvrService.LibraryName, Locations = new[] { root } });
        fake.Items.Add(item);

        var dvr = new DvrService(null!, null!, null!, null!, null!, null!, null!, library, null!, null!, null!, NullLogger<DvrService>.Instance);
        var job = new RecordingJob
        {
            State = JobState.Done,
            FilePath = file,
            ItemId = item.Id.ToString("N"),
            Game = new GameSnapshot { Id = "402", League = "MLB", Start = DateTimeOffset.UtcNow }
        };
        typeof(DvrService).GetField("_state", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(dvr, new DvrState { Settings = new DvrSettings { Folder = root }, Jobs = { job } });
        string Board() => dvr.ForGame("402", _ => string.Empty, dvr.LibraryStates())!.LibraryState;

        Assert.Equal(item.Id.ToString("N"), dvr.Jobs.Single().ItemId);
        Assert.Equal("ready", dvr.LibraryStates()(job));
        Assert.Equal("ready", Board());

        // the owner removes the library; the item is still found by id and by path, as in Jellyfin's memory
        fake.Folders.Clear();
        Assert.Null(dvr.Jobs.Single().ItemId);
        Assert.Null(job.ItemId);
        Assert.Equal("noLibrary", dvr.LibraryStates()(job));
        Assert.Equal("noLibrary", Board());
        Assert.Null(dvr.ForGame("402", _ => string.Empty)!.ItemId);

        // a library covers the folder again (the same file, the same item id): ready again
        fake.Folders.Add(new VirtualFolderInfo { Name = "Sports", Locations = new[] { root } });
        Assert.Equal(item.Id.ToString("N"), dvr.Jobs.Single().ItemId);
        Assert.Equal("ready", Board());

        // the item alone deleted (the library stays): adding until Jellyfin has it again
        fake.Items.Clear();
        Assert.Null(dvr.Jobs.Single().ItemId);
        Assert.Equal("adding", Board());
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

/// <summary>The few <see cref="ILibraryManager"/> calls the DVR's library bookkeeping makes, over a list of libraries and
/// items.</summary>
public class FakeLibrary : DispatchProxy
{
    public List<VirtualFolderInfo> Folders { get; } = new();

    public List<BaseItem> Items { get; } = new();

    public static ILibraryManager Create(out FakeLibrary fake)
    {
        var proxy = Create<ILibraryManager, FakeLibrary>();
        fake = (FakeLibrary)(object)proxy;
        return proxy;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        var name = targetMethod!.Name;
        if (name.StartsWith("add_", StringComparison.Ordinal) || name.StartsWith("remove_", StringComparison.Ordinal))
        {
            return null;
        }

        return name switch
        {
            "GetVirtualFolders" => Folders.ToList(),
            "GetItemById" when !targetMethod.IsGenericMethod => Items.FirstOrDefault(i => i.Id == (Guid)args![0]!),
            "FindByPath" => Items.FirstOrDefault(i => i.Path == (string)args![0]!),
            _ => throw new NotSupportedException(name)
        };
    }
}
