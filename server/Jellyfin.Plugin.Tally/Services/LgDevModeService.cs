using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Tally.Services;

/// <summary>One LG TV whose Developer Mode session the server keeps on.</summary>
public sealed class LgDevModeTv
{
    public string DeviceId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Token { get; set; } = string.Empty;

    public DateTimeOffset AddedAt { get; set; }

    public DateTimeOffset? LastAttempt { get; set; }

    public DateTimeOffset? RenewedAt { get; set; }

    /// <summary>What LG said when the last renewal failed (null after a success).</summary>
    public string? LastError { get; set; }

    /// <summary>The session time left after the last renewal ("999:59:58", LG's H:MM:SS), when LG said.</summary>
    public string? Remaining { get; set; }
}

/// <summary>What the settings page shows: "LG Developer Mode kept on for 1 TV · renewed …".</summary>
public sealed record LgDevModeSummary(int Tvs, DateTimeOffset? RenewedAt, int Failing, string? LastError);

/// <summary>
/// Keeps LG's Developer Mode on for the TVs Tally was installed on with Tally for LG. Apps installed in Developer Mode
/// stay only while its session lasts; when it runs out LG turns Developer Mode off at the next restart and removes the
/// apps, and an expired session cannot be extended (webostv.developer.lge.com, developer-mode-app). The Developer Mode
/// app's EXTEND button calls LG's session reset with the token the TV keeps in
/// /var/luna/preferences/devmode_enabled; Tally for LG reads that token, the TV app hands it here after sign-in
/// (POST /JellyTV/Client/v1/lg/devmode), and this service resets the session once a day, as the community tools do
/// (webosbrew dev-manager-desktop and dev-utils devmode-reset.sh: GET
/// https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=…, then CheckDevModeSession.dev for the
/// time left). Answers are JSON: {"result":"success","errorCode":"200","errorMsg":"GNL"} (the check puts the time
/// left, H:MM:SS, in errorMsg), or {"result":"fail","errorCode":"ERR_005","errorMsg":"Check user session"}.
/// Tokens stay in the plugin's data folder and are never returned by any endpoint.
/// </summary>
public sealed class LgDevModeService : BackgroundService
{
    public const string ResetUrl = "https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=";
    public const string CheckUrl = "https://developer.lge.com/secure/CheckDevModeSession.dev?sessionToken=";

    /// <summary>Renewed once a day; a failed renewal is tried again after an hour.</summary>
    public static readonly TimeSpan Every = TimeSpan.FromDays(1);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromHours(1);

    /// <summary>A TV that has failed for this long is forgotten (its token is dead: Developer Mode was switched off).</summary>
    public static readonly TimeSpan ForgetAfter = TimeSpan.FromDays(14);

    /// <summary>At most this many TVs (any signed-in user can register one).</summary>
    public const int MaxTvs = 20;

    private static readonly Regex TokenPattern = new("^[0-9A-Za-z]{8,512}$", RegexOptions.CultureInvariant);

    private readonly Func<HttpClient> _http;
    private readonly ILogger _logger;
    private readonly Func<string> _path;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _renewing = new(1, 1);
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private List<LgDevModeTv>? _tvs;

    public LgDevModeService(IHttpClientFactory httpClientFactory, ILogger<LgDevModeService> logger)
        : this(() => httpClientFactory.CreateClient("jellytv"), logger, () => Path.Combine(Plugin.Instance!.DataFolderPath, "lg-devmode.json"))
    {
    }

    /// <summary>For the tests: the HTTP client, the log and the file.</summary>
    public LgDevModeService(Func<HttpClient> http, ILogger logger, Func<string> path)
    {
        _http = http;
        _logger = logger;
        _path = path;
    }

    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;

    public static bool IsToken(string? token) => token != null && TokenPattern.IsMatch(token);

    /// <summary>
    /// Remembers a TV's token (one entry per TV: the same device id or the same token replaces the old one) and asks
    /// for a renewal soon. False for something that is not a token.
    /// </summary>
    public bool Register(string deviceId, string name, string token)
    {
        if (!IsToken(token) || string.IsNullOrWhiteSpace(deviceId))
        {
            return false;
        }

        lock (_lock)
        {
            var tvs = Load();
            var existing = tvs.FirstOrDefault(t => t.DeviceId == deviceId || t.Token == token);
            if (existing != null && existing.Token == token && existing.DeviceId == deviceId && existing.LastError == null)
            {
                // known and working: only the name may have changed
                existing.Name = Clean(name);
                Save(tvs);
                return true;
            }

            tvs.RemoveAll(t => t.DeviceId == deviceId || t.Token == token);
            if (tvs.Count >= MaxTvs)
            {
                tvs.RemoveAt(0);
            }

            tvs.Add(new LgDevModeTv { DeviceId = deviceId, Name = Clean(name), Token = token, AddedAt = Clock() });
            Save(tvs);
        }

        _logger.LogInformation("Tally: keeping LG Developer Mode on for {Tv}", Clean(name));
        _wake.Release();
        return true;
    }

    public IReadOnlyList<LgDevModeTv> Tvs
    {
        get
        {
            lock (_lock)
            {
                return Load().ToList();
            }
        }
    }

    public LgDevModeSummary Summary()
    {
        lock (_lock)
        {
            var tvs = Load();
            var failing = tvs.Where(t => t.LastError != null).ToList();
            return new LgDevModeSummary(tvs.Count, tvs.Max(t => t.RenewedAt), failing.Count, failing.Select(t => t.LastError).FirstOrDefault());
        }
    }

    /// <summary>Whether <paramref name="tv"/> is due: never tried, a day since the last success, an hour since a failure.</summary>
    public static bool IsDue(LgDevModeTv tv, DateTimeOffset now) =>
        tv.LastAttempt is not { } last
        || (tv.LastError == null ? now - (tv.RenewedAt ?? last) >= Every : now - last >= RetryAfter);

    /// <summary>Renews every TV that is due; returns how many were renewed.</summary>
    public async Task<int> RenewDueAsync(CancellationToken ct)
    {
        await _renewing.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            List<LgDevModeTv> due;
            lock (_lock)
            {
                due = Load().Where(t => IsDue(t, Clock())).Select(Copy).ToList();
            }

            var renewed = 0;
            foreach (var tv in due)
            {
                var result = await RenewAsync(tv.Token, ct).ConfigureAwait(false);
                var now = Clock();
                lock (_lock)
                {
                    var tvs = Load();
                    var entry = tvs.FirstOrDefault(t => t.DeviceId == tv.DeviceId && t.Token == tv.Token);
                    if (entry == null)
                    {
                        continue;
                    }

                    entry.LastAttempt = now;
                    if (result.Ok)
                    {
                        entry.RenewedAt = now;
                        entry.LastError = null;
                        entry.Remaining = result.Remaining;
                        renewed++;
                        _logger.LogInformation("Tally: LG Developer Mode renewed for {Tv}{Left}", entry.Name,
                            result.Remaining is { } left ? " (" + left + " left)" : string.Empty);
                    }
                    else
                    {
                        entry.LastError = result.Error;
                        _logger.LogWarning("Tally: could not renew LG Developer Mode for {Tv}: {Error}", entry.Name, result.Error);
                        if (now - (entry.RenewedAt ?? entry.AddedAt) > ForgetAfter)
                        {
                            tvs.Remove(entry);
                            _logger.LogWarning("Tally: stopped keeping LG Developer Mode on for {Tv} (failing for {Days} days)", entry.Name, ForgetAfter.Days);
                        }
                    }

                    Save(tvs);
                }
            }

            return renewed;
        }
        finally
        {
            _renewing.Release();
        }
    }

    public sealed record Outcome(bool Ok, string? Remaining, string? Error);

    /// <summary>Resets the session, then asks how long it now lasts (the check is informational only).</summary>
    public async Task<Outcome> RenewAsync(string token, CancellationToken ct)
    {
        try
        {
            var client = _http();
            var reset = Parse(await client.GetStringAsync(ResetUrl + Uri.EscapeDataString(token), ct).ConfigureAwait(false));
            if (!reset.Ok)
            {
                return reset;
            }

            try
            {
                var check = Parse(await client.GetStringAsync(CheckUrl + Uri.EscapeDataString(token), ct).ConfigureAwait(false));
                return reset with { Remaining = check.Ok && IsTimeLeft(check.Remaining) ? check.Remaining : null };
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                return reset;
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return new Outcome(false, null, "LG's server did not answer (" + ex.Message + ")");
        }
    }

    /// <summary>LG's answer: "success" is OK (errorMsg is then the time left, or "GNL"); anything else is an error.</summary>
    public static Outcome Parse(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            string? S(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var result = S("result");
            var message = S("errorMsg");
            if (string.Equals(result, "success", StringComparison.OrdinalIgnoreCase))
            {
                return new Outcome(true, message, null);
            }

            return new Outcome(false, null, string.Join(" ", new[] { S("errorCode"), message }.Where(s => !string.IsNullOrEmpty(s))) is { Length: > 0 } e ? e : "LG refused the renewal");
        }
        catch (JsonException)
        {
            return new Outcome(false, null, "LG's server sent something unexpected");
        }
    }

    /// <summary>"999:59:58": hours, minutes, seconds (the TV's start-devmode.sh checks the same shape).</summary>
    public static bool IsTimeLeft(string? s) => s != null && Regex.IsMatch(s, "^[0-9]{1,4}(:[0-5][0-9]){2}$", RegexOptions.CultureInvariant);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken).ConfigureAwait(false);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RenewDueAsync(stoppingToken).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Tally: LG Developer Mode renewal failed");
                }

                // hourly, or at once when a TV registers
                await _wake.WaitAsync(TimeSpan.FromHours(1), stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // stopping
        }
    }

    private static string Clean(string name)
    {
        var n = (name ?? string.Empty).Trim();
        n = new string(n.Where(c => !char.IsControl(c)).ToArray());
        return n.Length == 0 ? "an LG TV" : n.Length > 64 ? n[..64] : n;
    }

    private static LgDevModeTv Copy(LgDevModeTv t) => new()
    {
        DeviceId = t.DeviceId, Name = t.Name, Token = t.Token, AddedAt = t.AddedAt, LastAttempt = t.LastAttempt,
        RenewedAt = t.RenewedAt, LastError = t.LastError, Remaining = t.Remaining,
    };

    private List<LgDevModeTv> Load()
    {
        if (_tvs != null)
        {
            return _tvs;
        }

        try
        {
            var path = _path();
            _tvs = File.Exists(path) ? JsonSerializer.Deserialize<List<LgDevModeTv>>(File.ReadAllText(path)) ?? new() : new();
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Tally: could not read the LG Developer Mode list");
            _tvs = new();
        }

        return _tvs;
    }

    private void Save(List<LgDevModeTv> tvs)
    {
        _tvs = tvs;
        try
        {
            var path = _path();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(tvs));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Tally: could not save the LG Developer Mode list");
        }
    }
}
