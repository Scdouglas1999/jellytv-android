using System.Text.Json;

namespace Tally.Installer;

public sealed record ServerCheck(string Address, string Name, string Version, bool HasTvApp);

/// <summary>
/// Checks the Jellyfin address the person types, the way the TV shell will use it: <c>/System/Info/Public</c> must
/// answer as Jellyfin, and <c>/JellyTV/TV/manifest.json</c> tells whether the server's Tally plugin carries the TV app.
/// </summary>
public sealed class JellyfinServer(HttpClient http)
{
    /// <summary>
    /// The addresses to try for what was typed: as typed when it has a scheme; otherwise https first (a server on the
    /// internet), then http with Jellyfin's port 8096 when no port was given (a server at home), then http as typed.
    /// </summary>
    public static IReadOnlyList<string> Candidates(string typed)
    {
        var a = typed.Trim().TrimEnd('/');
        if (a.Length == 0)
        {
            return [];
        }

        if (a.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || a.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(a, UriKind.Absolute, out var uri))
            {
                return [];
            }

            // as the shell: http without a port and without a path means Jellyfin's 8096
            if (uri.Scheme == "http" && uri.IsDefaultPort && !a[(uri.Scheme.Length + 3)..].Contains(':')
                && (uri.AbsolutePath == "/" || uri.AbsolutePath.Length == 0))
            {
                return [a + ":8096", a];
            }

            return [a];
        }

        if (!Uri.TryCreate("http://" + a, UriKind.Absolute, out var bare))
        {
            return [];
        }

        var hasPort = !bare.IsDefaultPort || a.Split('/')[0].Contains(':');
        var list = new List<string>();
        if (hasPort)
        {
            list.Add("http://" + a);
            list.Add("https://" + a);
        }
        else
        {
            list.Add("https://" + a);
            list.Add("http://" + HostAndPath(a, ":8096"));
            list.Add("http://" + a);
        }

        return list;
    }

    private static string HostAndPath(string a, string port)
    {
        var slash = a.IndexOf('/');
        return slash < 0 ? a + port : a[..slash] + port + a[slash..];
    }

    /// <summary>The first candidate that answers as Jellyfin, or null (with what each one said).</summary>
    public async Task<(ServerCheck? Server, List<string> Problems)> CheckAsync(string typed, CancellationToken ct)
    {
        var problems = new List<string>();
        foreach (var address in Candidates(typed))
        {
            try
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
                limit.CancelAfter(TimeSpan.FromSeconds(8));
                using var response = await http.GetAsync(address + "/System/Info/Public", limit.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    problems.Add($"{address}: answered HTTP {(int)response.StatusCode}");
                    continue;
                }

                var body = await response.Content.ReadAsStringAsync(limit.Token).ConfigureAwait(false);
                string name, version;
                try
                {
                    using var doc = JsonDocument.Parse(body);
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("Id", out _) || !root.TryGetProperty("Version", out var v))
                    {
                        problems.Add($"{address}: not a Jellyfin server");
                        continue;
                    }

                    version = v.GetString() ?? "";
                    name = root.TryGetProperty("ServerName", out var n) ? n.GetString() ?? "" : "";
                }
                catch (JsonException)
                {
                    problems.Add($"{address}: not a Jellyfin server");
                    continue;
                }

                var hasTvApp = false;
                try
                {
                    using var manifest = await http.GetAsync(address + "/JellyTV/TV/manifest.json", limit.Token).ConfigureAwait(false);
                    hasTvApp = manifest.IsSuccessStatusCode;
                }
                catch (HttpRequestException)
                {
                    // answered once, so the server is there; the TV app check alone failed
                }

                return (new ServerCheck(address, name, version, hasTvApp), problems);
            }
            catch (HttpRequestException ex)
            {
                problems.Add($"{address}: {ex.HttpRequestError switch
                {
                    HttpRequestError.NameResolutionError => "name not found",
                    HttpRequestError.ConnectionError => "no answer",
                    HttpRequestError.SecureConnectionError => "secure connection failed",
                    _ => ex.Message,
                }}");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                problems.Add($"{address}: no answer in 8 seconds");
            }
        }

        return (null, problems);
    }
}
