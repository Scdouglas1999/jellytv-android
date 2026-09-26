using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Tally.Scores;
using Microsoft.Extensions.Logging;
using SkiaSharp;

namespace Jellyfin.Plugin.Tally.Services;

/// <summary>
/// Text-free matchup art used as an app backdrop while a game is focused (the Android app hands it to Wholphin's
/// backdrop, which fades it in top-right and tints the page from its colors). Nothing on it depends on the score
/// or the clock, so a game's art is rendered once and cached.
/// </summary>
public sealed class GameArtService
{
    public const int Width = 1920;
    public const int Height = 1080;

    // every size of a game's art is one entry (the full size, which the smaller ones are scaled from, plus the sizes
    // apps ask for)
    private const int CacheLimit = 128;
    private const int LogoBox = 400;
    private const float SeamFeather = 80f;
    private const float LeftFade = 240f;

    private static readonly SKColor Ground = new(0x0e, 0x0f, 0x0e);
    private static readonly SKColor Neutral = new(0x1b, 0x1c, 0x1a);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ScoreboardService _scoreboard;
    private readonly ILogger<GameArtService> _logger;

    private readonly Dictionary<string, byte[]?> _logos = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _cacheGate = new();
    private readonly Dictionary<string, LinkedListNode<CachedArt>> _cache = new(StringComparer.Ordinal);
    private readonly LinkedList<CachedArt> _recent = new();

    public GameArtService(IHttpClientFactory httpClientFactory, ScoreboardService scoreboard, ILogger<GameArtService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _scoreboard = scoreboard;
        _logger = logger;
    }

    /// <summary>Root-relative path of a game's backdrop (the Client API prefixes the base path).</summary>
    public static string BackdropPath(GameInfo game) => $"/JellyTV/Backdrop/{Uri.EscapeDataString(game.Id)}.png";

    /// <summary>The art for <paramref name="gameId"/>, <paramref name="width"/> wide (null: full size); a plain
    /// ground-colored frame when the game is unknown.</summary>
    public async Task<byte[]> RenderAsync(string gameId, int? width, CancellationToken ct)
    {
        try
        {
            if (string.IsNullOrEmpty(gameId))
            {
                return RenderPlain(width);
            }

            var sizedKey = CacheKey(gameId, width);
            if (TryGetCached(sizedKey, out var cached))
            {
                return cached;
            }

            if (!TryGetCached(CacheKey(gameId, null), out var full))
            {
                var games = await _scoreboard.GetGamesAsync(ct).ConfigureAwait(false);
                var game = games.FirstOrDefault(g => string.Equals(g.Id, gameId, StringComparison.Ordinal));
                if (game == null)
                {
                    return RenderPlain(width);
                }

                var away = await GetLogoAsync(game.Away?.Logo, ct).ConfigureAwait(false);
                var home = await GetLogoAsync(game.Home?.Logo, ct).ConfigureAwait(false);
                full = Render(game, away, home);
                Store(CacheKey(gameId, null), full);
            }

            if (width is not { } w)
            {
                return full;
            }

            var png = ArtRequest.Scale(full, w);
            Store(sizedKey, png);
            return png;
        }
        catch (Exception ex)
        {
            _logger.LogDebug("JellyTV backdrop: {GameId} could not be drawn: {Message}", gameId, ex.Message);
            return RenderPlain(width);
        }
    }

    /// <summary>Cache key of one drawn backdrop: the game and the width (null: full size). No zone: a backdrop has no
    /// text, so it is the same in every zone.</summary>
    public static string CacheKey(string gameId, int? width)
        => width is { } w ? gameId + "@" + w.ToString(CultureInfo.InvariantCulture) : gameId;

    /// <summary>The backdrop for a game the caller already has (the DVR's fanart for a finished recording, whose game
    /// may have left the board). Not cached.</summary>
    public async Task<byte[]> RenderGameAsync(GameInfo game, CancellationToken ct)
    {
        var away = await GetLogoAsync(game.Away?.Logo, ct).ConfigureAwait(false);
        var home = await GetLogoAsync(game.Home?.Logo, ct).ConfigureAwait(false);
        return Render(game, away, home);
    }

    private static readonly ConcurrentDictionary<int, byte[]> PlainFrames = new();

    /// <summary>The plain frame <paramref name="width"/> wide (null: full size), drawn once per size.</summary>
    public static byte[] RenderPlain(int? width)
        => PlainFrames.GetOrAdd(width ?? Width, w => w >= Width ? RenderPlain() : ArtRequest.Scale(RenderPlain(), w));

    /// <summary>A flat ground-colored frame (unknown game, or no logos and no colors).</summary>
    public static byte[] RenderPlain()
    {
        using var surface = SKSurface.Create(new SKImageInfo(Width, Height, SKColorType.Rgba8888, SKAlphaType.Premul));
        surface.Canvas.Clear(Ground);
        using var image = surface.Snapshot();
        return Encode(image);
    }

    /// <summary>Text-free 1920×1080 matchup. Either logo may be missing; that side is then just its color field.</summary>
    public static byte[] Render(GameInfo game, byte[]? awayLogo, byte[]? homeLogo)
    {
        using var awayBmp = DecodeLogo(awayLogo);
        using var homeBmp = DecodeLogo(homeLogo);
        var away = ChooseColor(game.Away, awayBmp);
        var home = ChooseColor(game.Home, homeBmp);

        var info = new SKImageInfo(Width, Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bmp = new SKBitmap(info);
        bmp.Pixels = PaintFields(away.Color, home.Color);
        using (var canvas = new SKCanvas(bmp))
        {
            DrawMark(canvas, awayBmp, away, 0.60f * Width, 0.37f * Height);
            DrawMark(canvas, homeBmp, home, 0.85f * Width, 0.37f * Height);
        }

        // Diagonal pinstripes defeat PNG predictors. Snapping blend pixels to even channels
        // (at most one level) keeps the frame under the size budget; flat ground stays exact.
        SnapBlends(bmp);
        using var image = SKImage.FromBitmap(bmp);
        return Encode(image);
    }

    /// <summary>Team color after the swallow test and the near-black lift. Neutral is not lifted.</summary>
    private readonly record struct TeamPaint(SKColor Color, double LogoLuminance, bool HasLogo);

    private static TeamPaint ChooseColor(GameTeam? team, SKBitmap? logo)
    {
        var primary = ParseHex(team?.Color);
        var alt = ParseHex(team?.AltColor);
        var sample = SampleLogo(logo);

        if (primary == null && alt == null)
        {
            return new TeamPaint(Neutral, sample.Luminance, sample.HasOpaque);
        }

        var chosen = primary ?? alt!.Value;
        if (primary != null && alt != null && sample.HasOpaque && Swallows(sample, primary.Value))
        {
            chosen = alt.Value;
        }

        if (Luminance(chosen) < 0.06)
        {
            chosen = Mix(chosen, SKColors.White, 0.12);
        }

        return new TeamPaint(chosen, sample.Luminance, sample.HasOpaque);
    }

    /// <summary>Primary would hide the mark: the mark is close to it, or both are too dark to separate (navy on navy).</summary>
    private static bool Swallows(LogoSample logo, SKColor primary)
        => RgbDistance(logo.Average, primary) <= 90
            || (Luma(logo.Average) < 0.12 && Luma(primary) < 0.12);

    private static SKColor[] PaintFields(SKColor awayTeam, SKColor homeTeam)
    {
        var awayField = Mix(Ground, awayTeam, 0.42);
        var homeField = Mix(Ground, homeTeam, 0.42);
        var awayLight = Mix(awayTeam, SKColors.White, 0.18);
        var homeLight = Mix(homeTeam, SKColors.White, 0.18);

        // Seam from (0.75W, 0) to (0.69W, H). Normal points toward the home side.
        var seamX0 = 0.75 * Width;
        var seamDx = (0.69 * Width) - seamX0;
        var seamDy = (double)Height;
        var seamLen = Math.Sqrt((seamDx * seamDx) + (seamDy * seamDy));
        var nx = seamDy / seamLen;
        var ny = -seamDx / seamLen;

        var fade0 = (0.38 * Width) - LeftFade;
        var fade1 = 0.38 * Width;
        var radius = 0.42 * Height;
        var awayCx = 0.60 * Width;
        var homeCx = 0.85 * Width;
        var logoY = 0.37 * Height;

        // 60° lines, 1px thick, 14px apart. Normal is perpendicular to the line direction.
        const double stripeAngle = Math.PI / 3.0;
        var sx = -Math.Sin(stripeAngle);
        var sy = Math.Cos(stripeAngle);

        var pixels = new SKColor[Width * Height];
        for (var y = 0; y < Height; y++)
        {
            var row = y * Width;
            var py = y + 0.5;
            for (var x = 0; x < Width; x++)
            {
                var px = x + 0.5;
                var signed = ((px - seamX0) * nx) + (py * ny);
                var homeW = Smooth((signed + (SeamFeather / 2.0)) / SeamFeather);
                var awayFade = Smooth((px - fade0) / (fade1 - fade0));
                var awayA = awayFade * (1.0 - homeW);
                var homeA = homeW;
                var presence = awayA + homeA;

                double r = Ground.Red;
                double g = Ground.Green;
                double b = Ground.Blue;
                r = (r * (1.0 - presence)) + (awayField.Red * awayA) + (homeField.Red * homeA);
                g = (g * (1.0 - presence)) + (awayField.Green * awayA) + (homeField.Green * homeA);
                b = (b * (1.0 - presence)) + (awayField.Blue * awayA) + (homeField.Blue * homeA);

                var awayGlow = Glow(px, py, awayCx, logoY, radius);
                var homeGlow = Glow(px, py, homeCx, logoY, radius);
                Over(ref r, ref g, ref b, awayLight, 0.30 * awayGlow * awayA);
                Over(ref r, ref g, ref b, homeLight, 0.30 * homeGlow * homeA);

                var dist = (px * sx) + (py * sy);
                var phase = dist % 14.0;
                if (phase < 0)
                {
                    phase += 14.0;
                }

                var nearest = Math.Min(phase, 14.0 - phase);
                if (nearest < 0.5 && presence > 0)
                {
                    Over(ref r, ref g, ref b, SKColors.White, 0.035 * presence);
                }

                pixels[row + x] = new SKColor(Byte(r), Byte(g), Byte(b));
            }
        }

        return pixels;
    }

    private static void DrawMark(SKCanvas canvas, SKBitmap? logo, TeamPaint team, float cx, float cy)
    {
        if (logo == null || !team.HasLogo)
        {
            return;
        }

        // A dark mark on a dark field needs a breath of light behind it or it disappears into the slate.
        var field = Mix(Ground, team.Color, 0.42);
        if (team.LogoLuminance < 0.2 && Luminance(field) < 0.25)
        {
            using var halo = SKShader.CreateRadialGradient(
                new SKPoint(cx, cy),
                250f,
                new[] { new SKColor(255, 255, 255, 23), new SKColor(255, 255, 255, 0) },
                SKShaderTileMode.Clamp);
            using var haloPaint = new SKPaint { Shader = halo, IsAntialias = true };
            canvas.DrawCircle(cx, cy, 250f, haloPaint);
        }

        var scale = Math.Min(LogoBox / (float)logo.Width, LogoBox / (float)logo.Height);
        var w = logo.Width * scale;
        var h = logo.Height * scale;
        var dest = new SKRect(cx - (w / 2f), cy - (h / 2f), cx + (w / 2f), cy + (h / 2f));
        using var shadow = SKImageFilter.CreateDropShadow(0, 10, 28, 28, new SKColor(0, 0, 0, 115));
        using var paint = new SKPaint { ImageFilter = shadow, FilterQuality = SKFilterQuality.High, IsAntialias = true };
        canvas.DrawBitmap(logo, dest, paint);
    }

    private static double Glow(double x, double y, double cx, double cy, double radius)
    {
        var dx = x - cx;
        var dy = y - cy;
        var d = Math.Sqrt((dx * dx) + (dy * dy));
        return d >= radius ? 0 : 1.0 - Smooth(d / radius);
    }

    private static void Over(ref double r, ref double g, ref double b, SKColor src, double a)
    {
        if (a <= 0)
        {
            return;
        }

        r = (src.Red * a) + (r * (1.0 - a));
        g = (src.Green * a) + (g * (1.0 - a));
        b = (src.Blue * a) + (b * (1.0 - a));
    }

    private static double Smooth(double t)
    {
        if (t <= 0)
        {
            return 0;
        }

        if (t >= 1)
        {
            return 1;
        }

        return t * t * (3.0 - (2.0 * t));
    }

    private static byte Byte(double c) => (byte)Math.Clamp((int)Math.Round(c), 0, 255);

    private static SKColor Mix(SKColor a, SKColor b, double t)
        => new(Byte(a.Red + ((b.Red - a.Red) * t)), Byte(a.Green + ((b.Green - a.Green) * t)), Byte(a.Blue + ((b.Blue - a.Blue) * t)));

    /// <summary>
    /// Perceived luma, 0–1. The 0.12 swallow test uses this rather than the sRGB curve: a saturated red
    /// mark is darker than 0.12 after the curve and would be treated as navy-on-navy, swapping a red
    /// logo onto a red field. Rec. 709 weights keep that red light enough to stay on a dark primary.
    /// </summary>
    private static double Luma(SKColor c)
        => ((0.2126 * c.Red) + (0.7152 * c.Green) + (0.0722 * c.Blue)) / 255.0;

    /// <summary>sRGB relative luminance. Used for the near-black lift and the dark-on-dark halo, where navy must count as dark.</summary>
    private static double Luminance(SKColor c)
    {
        static double Lin(byte channel)
        {
            var s = channel / 255.0;
            return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }

        return (0.2126 * Lin(c.Red)) + (0.7152 * Lin(c.Green)) + (0.0722 * Lin(c.Blue));
    }

    private static double RgbDistance(SKColor a, SKColor b)
    {
        var dr = a.Red - b.Red;
        var dg = a.Green - b.Green;
        var db = a.Blue - b.Blue;
        return Math.Sqrt((dr * dr) + (dg * dg) + (db * db));
    }

    private static SKColor? ParseHex(string? hex)
    {
        if (string.IsNullOrEmpty(hex) || hex.Length != 6)
        {
            return null;
        }

        if (!uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb))
        {
            return null;
        }

        return new SKColor((byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
    }

    private readonly record struct LogoSample(SKColor Average, double Luminance, bool HasOpaque);

    private static LogoSample SampleLogo(SKBitmap? logo)
    {
        if (logo == null)
        {
            return default;
        }

        long r = 0, g = 0, b = 0, n = 0;
        var pixels = logo.Pixels;
        foreach (var c in pixels)
        {
            if (c.Alpha < 128)
            {
                continue;
            }

            r += c.Red;
            g += c.Green;
            b += c.Blue;
            n++;
        }

        if (n == 0)
        {
            return default;
        }

        var average = new SKColor((byte)((r + (n / 2)) / n), (byte)((g + (n / 2)) / n), (byte)((b + (n / 2)) / n));
        return new LogoSample(average, Luminance(average), true);
    }

    private static SKBitmap? DecodeLogo(byte[]? bytes)
    {
        if (bytes == null || bytes.Length == 0)
        {
            return null;
        }

        try
        {
            return SKBitmap.Decode(bytes);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static void SnapBlends(SKBitmap bmp)
    {
        var pixels = bmp.Pixels;
        for (var i = 0; i < pixels.Length; i++)
        {
            var c = pixels[i];
            if (c.Red == Ground.Red && c.Green == Ground.Green && c.Blue == Ground.Blue)
            {
                continue;
            }

            pixels[i] = new SKColor(Even(c.Red), Even(c.Green), Even(c.Blue));
        }

        bmp.Pixels = pixels;
    }

    private static byte Even(byte v) => (byte)Math.Clamp(((v + 1) / 2) * 2, 0, 255);

    private static byte[] Encode(SKImage image)
    {
        using var bitmap = SKBitmap.FromImage(image);
        var colors = bitmap.Pixels;
        var raw = new byte[colors.Length * 4];
        for (var i = 0; i < colors.Length; i++)
        {
            raw[(i * 4) + 0] = colors[i].Red;
            raw[(i * 4) + 1] = colors[i].Green;
            raw[(i * 4) + 2] = colors[i].Blue;
            raw[(i * 4) + 3] = 255;
        }

        var info = new SKImageInfo(bitmap.Width, bitmap.Height, SKColorType.Rgb888x, SKAlphaType.Opaque);
        var handle = GCHandle.Alloc(raw, GCHandleType.Pinned);
        try
        {
            using var pixmap = new SKPixmap(info, handle.AddrOfPinnedObject(), info.RowBytes);
            using var data = pixmap.Encode(new SKPngEncoderOptions(SKPngEncoderFilterFlags.AllFilters, 9));
            if (data != null)
            {
                return data.ToArray();
            }
        }
        finally
        {
            handle.Free();
        }

        using var fallback = image.Encode(SKEncodedImageFormat.Png, 100);
        return fallback.ToArray();
    }

    private bool TryGetCached(string key, out byte[] png)
    {
        lock (_cacheGate)
        {
            if (_cache.TryGetValue(key, out var node))
            {
                _recent.Remove(node);
                _recent.AddFirst(node);
                png = node.Value.Png;
                return true;
            }
        }

        png = Array.Empty<byte>();
        return false;
    }

    private void Store(string key, byte[] png)
    {
        lock (_cacheGate)
        {
            if (_cache.TryGetValue(key, out var existing))
            {
                existing.Value.Png = png;
                _recent.Remove(existing);
                _recent.AddFirst(existing);
                return;
            }

            var node = new LinkedListNode<CachedArt>(new CachedArt(key, png));
            _recent.AddFirst(node);
            _cache.Add(key, node);
            while (_cache.Count > CacheLimit)
            {
                var last = _recent.Last!;
                _cache.Remove(last.Value.Id);
                _recent.RemoveLast();
            }
        }
    }

    /// <summary>The card is fetched the same way as channel art: the named client, an honest User-Agent, and only the ESPN logo CDN.</summary>
    private async Task<byte[]?> GetLogoAsync(string? url, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(url))
        {
            return null;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || !uri.Host.EndsWith(".espncdn.com", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        lock (_logos)
        {
            if (_logos.TryGetValue(url, out var cached))
            {
                return cached;
            }
        }

        try
        {
            var client = _httpClientFactory.CreateClient("jellytv");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(8));
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.TryAddWithoutValidation("User-Agent", "JellyTV/" + (Plugin.Instance?.Version?.ToString() ?? "0.1"));
            using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            var bytes = await response.Content.ReadAsByteArrayAsync(timeout.Token).ConfigureAwait(false);
            if (bytes.Length is > 0 and < 2_000_000)
            {
                lock (_logos)
                {
                    _logos[url] = bytes;
                }

                return bytes;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // A missing mark is just an empty side. Canceling the request still bails out of the whole draw.
            _logger.LogDebug("JellyTV backdrop: logo fetch failed for {Url}: {Message}", url, ex.Message);
        }

        return null;
    }

    private sealed class CachedArt
    {
        public CachedArt(string id, byte[] png)
        {
            Id = id;
            Png = png;
        }

        public string Id { get; }

        public byte[] Png { get; set; }
    }
}
