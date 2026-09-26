using System.Net;
using System.Text.Json;
using Tally.SamsungInstaller.Sdb;

namespace Tally.SamsungInstaller.Tv;

/// <summary>A Samsung TV (or an sdb device) found on the network.</summary>
public sealed record TvFound(
    IPAddress Address,
    string? Name,
    string? ModelName,
    string? ModelCode,
    bool? DeveloperMode,
    string? DeveloperIp,
    bool SdbPortOpen)
{
    /// <summary>The model year from the model code ("20_KANTM2_UHD" → 2020), when the TV says.</summary>
    public int? ModelYear =>
        ModelCode is { Length: >= 3 } code && code[2] == '_' && int.TryParse(code[..2], out var yy) ? 2000 + yy : null;

    public string Label
    {
        get
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(Name))
            {
                parts.Add(Name!.Replace("[TV] ", "", StringComparison.Ordinal));
            }

            if (!string.IsNullOrWhiteSpace(ModelName))
            {
                parts.Add(ModelName!);
            }

            if (ModelYear is { } year)
            {
                parts.Add(year + " model");
            }

            return parts.Count == 0 ? "a device with Developer Mode's port open" : string.Join(", ", parts);
        }
    }
}

/// <summary>
/// Finds Samsung TVs on this PC's networks: every address of each local IPv4 network (the /24 around this PC's
/// address) is asked, at the same time, for Samsung's TV information (<c>http://&lt;ip&gt;:8001/api/v2/</c>: name,
/// model, and on TVs that report it, <c>developerMode</c> and <c>developerIP</c>) and whether the sdb port (26101)
/// takes a connection.
/// </summary>
public sealed class TvScanner(HttpClient http)
{
    public int SdbPort { get; init; } = SdbClient.DefaultPort;
    public int InfoPort { get; init; } = 8001;
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromMilliseconds(900);
    public TimeSpan InfoTimeout { get; init; } = TimeSpan.FromSeconds(2);

    /// <summary>This PC's IPv4 networks: (address, the /24 to scan).</summary>
    public static IReadOnlyList<(IPAddress Local, IReadOnlyList<IPAddress> Hosts)> LocalNetworks() => NetworkScan.LocalNetworks();

    public static IEnumerable<IPAddress> Slash24(IPAddress ip) => NetworkScan.Slash24(ip);

    /// <summary>Home networks (10/8, 172.16/12, 192.168/16, 100.64/10): a TV is never on a public address.</summary>
    public static bool IsPrivate(IPAddress ip) => NetworkScan.IsPrivate(ip);

    /// <summary>Scans the given addresses; returns TVs and open sdb ports, in address order.</summary>
    public Task<IReadOnlyList<TvFound>> ScanAsync(IEnumerable<IPAddress> hosts, CancellationToken ct,
        IProgress<int>? progress = null) =>
        NetworkScan.ScanAsync(hosts, ProbeAsync, tv => tv.Address, ct, progress);

    /// <summary>One address: Samsung's TV information and the sdb port. Null when neither answers.</summary>
    public async Task<TvFound?> ProbeAsync(IPAddress ip, CancellationToken ct)
    {
        var sdb = PortOpenAsync(ip, SdbPort, ct);
        var info = InfoAsync(ip, ct);
        await Task.WhenAll(sdb, info).ConfigureAwait(false);
        var device = info.Result;
        if (device is null && !sdb.Result)
        {
            return null;
        }

        return device is null
            ? new TvFound(ip, null, null, null, null, null, true)
            : device with { SdbPortOpen = sdb.Result };
    }

    private Task<bool> PortOpenAsync(IPAddress ip, int port, CancellationToken ct) =>
        NetworkScan.PortOpenAsync(ip, port, ConnectTimeout, ct);

    private async Task<TvFound?> InfoAsync(IPAddress ip, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(InfoTimeout);
        try
        {
            using var response = await http.GetAsync($"http://{ip}:{InfoPort}/api/v2/", limit.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(limit.Token).ConfigureAwait(false);
            return ParseInfo(ip, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }

    /// <summary>Samsung's <c>/api/v2/</c> answer; null when it is not a Samsung TV.</summary>
    public static TvFound? ParseInfo(IPAddress ip, string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (!root.TryGetProperty("device", out var device) || device.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? S(string name) => device.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var type = S("type") ?? (root.TryGetProperty("type", out var t) ? t.GetString() : null);
            if (type is null || !type.Contains("Samsung", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            bool? devMode = S("developerMode") switch { "1" => true, "0" => false, _ => null };
            var devIp = S("developerIP");
            return new TvFound(ip, S("name") ?? (root.TryGetProperty("name", out var n) ? n.GetString() : null),
                S("modelName"), S("model"), devMode, string.IsNullOrWhiteSpace(devIp) ? null : devIp, false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The address this PC uses to reach <paramref name="tv"/> (what Developer Mode's Host PC IP must be).</summary>
    public static IPAddress? LocalAddressFor(IPAddress tv) => NetworkScan.LocalAddressFor(tv);
}
