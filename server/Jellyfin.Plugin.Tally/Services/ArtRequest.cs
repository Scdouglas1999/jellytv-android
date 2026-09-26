using System;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace Jellyfin.Plugin.Tally.Services;

/// <summary>
/// The query parameters the game art endpoints (<c>/JellyTV/Card/{key}.png</c>, <c>/JellyTV/Backdrop/{gameId}.png</c>)
/// take from apps: <c>w</c>, the width the app draws the image at, and <c>tz</c>, the viewer's IANA time zone for the
/// times drawn in the art. Both are optional and forgiving: anything the server cannot use means full size and the
/// server's own zone, never an error.
/// </summary>
public static partial class ArtRequest
{
    /// <summary>The widths art is served at. A requested width snaps up to the next one, so each image has at most six
    /// sizes to cache however many different widths apps ask for.</summary>
    public static readonly int[] Widths = { 320, 480, 640, 960, 1280, 1920 };

    /// <summary>The width to scale to, or null for the art's own size: no or bad <c>w</c>, or a snapped width that is
    /// not smaller than the art (<paramref name="fullWidth"/>).</summary>
    public static int? SnapWidth(string? w, int fullWidth)
    {
        if (string.IsNullOrWhiteSpace(w)
            || !int.TryParse(w.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var requested)
            || requested <= 0)
        {
            return null;
        }

        var snapped = Widths.FirstOrDefault(x => x >= requested);
        return snapped == 0 || snapped >= fullWidth ? null : snapped;
    }

    /// <summary>The viewer's zone for <c>tz</c> (an IANA id such as America/New_York), or the
    /// server's own zone when it is missing or unknown. On Windows .NET resolves IANA ids through ICU.</summary>
    public static TimeZoneInfo Zone(string? tz)
    {
        if (string.IsNullOrWhiteSpace(tz))
        {
            return TimeZoneInfo.Local;
        }

        var id = tz.Trim();
        // only what zone ids are made of: the id becomes a file name under /usr/share/zoneinfo on Linux
        if (!ZoneId().IsMatch(id) || id.Contains("..", StringComparison.Ordinal))
        {
            return TimeZoneInfo.Local;
        }

        return TimeZoneInfo.TryFindSystemTimeZoneById(id, out var zone) ? zone : TimeZoneInfo.Local;
    }

    /// <summary>The zone's part of a cache key.</summary>
    public static string ZoneKey(TimeZoneInfo zone) => zone.Id;

    /// <summary>The art scaled to <paramref name="width"/> (height keeps the aspect ratio), as PNG. Downscaling uses
    /// Skia's high-quality filter (mipmaps), so text and logos stay clean at a quarter of the size.</summary>
    public static byte[] Scale(byte[] png, int width)
    {
        using var full = SKBitmap.Decode(png);
        if (full == null || width >= full.Width)
        {
            return png;
        }

        var height = Math.Max(1, (int)Math.Round(full.Height * (width / (double)full.Width)));
        // the art is opaque: no alpha channel in the file, and the smallest PNG zlib makes (the backdrops' full size is
        // encoded the same way)
        var info = new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Opaque);
        using var scaled = full.Resize(info, SKFilterQuality.High);
        if (scaled == null)
        {
            return png;
        }

        using var pixels = scaled.PeekPixels();
        using var data = pixels?.Encode(new SKPngEncoderOptions(SKPngEncoderFilterFlags.AllFilters, 9));
        return data?.ToArray() ?? png;
    }

    [GeneratedRegex("^[A-Za-z0-9_+\\-/]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ZoneId();
}
