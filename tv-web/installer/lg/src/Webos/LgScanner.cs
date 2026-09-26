using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace Tally.LgInstaller.Webos;

/// <summary>An LG TV (or a Developer Mode port) found on the network.</summary>
public sealed record LgFound(IPAddress Address, string? Name, string? Model, bool DeveloperMode, bool KeyServer, bool Webos)
{
    public string Label
    {
        get
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(Name))
            {
                parts.Add(Name!);
            }

            if (!string.IsNullOrWhiteSpace(Model) && Model != Name)
            {
                parts.Add(Model!);
            }

            return parts.Count > 0 ? string.Join(", ", parts) : Webos ? "an LG TV" : "a device with Developer Mode's port open";
        }
    }

    public string Status => (DeveloperMode, KeyServer) switch
    {
        (true, true) => "Developer Mode is on, Key Server is on: ready",
        (true, false) => "Developer Mode is on, Key Server is off (turn it on in the Developer Mode app)",
        (false, true) => "Key Server is on, but Developer Mode's port does not answer (restart the TV after switching Developer Mode on)",
        _ => "Developer Mode is off",
    };
}

/// <summary>
/// Finds LG TVs on this PC's networks: every address of the /24 around this PC is asked whether Developer Mode's
/// SSH port (9922) and Key Server (9991) take a connection, and whether webOS's second-screen port (3000, what LG's
/// phone apps use) does; names come from SSDP (<c>urn:lge-com:service:webos-second-screen:1</c>, the service LG's
/// ThinQ app and the open webOS remote libraries search for), where the TV answers.
/// </summary>
public sealed class LgScanner
{
    public int SshPort { get; init; } = 9922;
    public int KeyPort { get; init; } = DevModeKey.KeyServerPort;
    public int WebosPort { get; init; } = 3000;
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromMilliseconds(900);
    public TimeSpan SsdpTime { get; init; } = TimeSpan.FromSeconds(2);

    public async Task<IReadOnlyList<LgFound>> ScanAsync(IEnumerable<IPAddress> hosts, CancellationToken ct)
    {
        var names = SsdpAsync(ct);
        var found = await NetworkScan.ScanAsync(hosts, ProbeAsync, f => f.Address, ct).ConfigureAwait(false);
        var named = await names.ConfigureAwait(false);
        return found.Select(f => named.TryGetValue(f.Address.ToString(), out var n) ? f with { Name = n.Name, Model = n.Model, Webos = true } : f).ToList();
    }

    public async Task<LgFound?> ProbeAsync(IPAddress ip, CancellationToken ct)
    {
        var ssh = NetworkScan.PortOpenAsync(ip, SshPort, ConnectTimeout, ct);
        var key = NetworkScan.PortOpenAsync(ip, KeyPort, ConnectTimeout, ct);
        var webos = NetworkScan.PortOpenAsync(ip, WebosPort, ConnectTimeout, ct);
        await Task.WhenAll(ssh, key, webos).ConfigureAwait(false);
        if (!ssh.Result && !key.Result && !webos.Result)
        {
            return null;
        }

        return new LgFound(ip, null, null, ssh.Result, key.Result, webos.Result);
    }

    /// <summary>LG TVs that answer an SSDP search: address → (friendly name, model).</summary>
    public async Task<Dictionary<string, (string? Name, string? Model)>> SsdpAsync(CancellationToken ct)
    {
        var result = new Dictionary<string, (string?, string?)>();
        try
        {
            using var udp = new UdpClient(AddressFamily.InterNetwork);
            udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            var search = Encoding.ASCII.GetBytes(
                "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\n" +
                "ST: urn:lge-com:service:webos-second-screen:1\r\n\r\n");
            var to = new IPEndPoint(IPAddress.Parse("239.255.255.250"), 1900);
            await udp.SendAsync(search, to, ct).ConfigureAwait(false);
            await udp.SendAsync(search, to, ct).ConfigureAwait(false);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(SsdpTime);
            var locations = new Dictionary<string, string>();
            try
            {
                while (true)
                {
                    var r = await udp.ReceiveAsync(limit.Token).ConfigureAwait(false);
                    var text = Encoding.ASCII.GetString(r.Buffer);
                    var location = Regex.Match(text, @"^LOCATION:\s*(\S+)", RegexOptions.IgnoreCase | RegexOptions.Multiline);
                    if (location.Success)
                    {
                        locations[r.RemoteEndPoint.Address.ToString()] = location.Groups[1].Value;
                    }
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // the search time is over
            }

            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            foreach (var (ip, url) in locations)
            {
                try
                {
                    var xml = await http.GetStringAsync(url, ct).ConfigureAwait(false);
                    result[ip] = (Tag(xml, "friendlyName"), Tag(xml, "modelName"));
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or UriFormatException && !ct.IsCancellationRequested)
                {
                    result[ip] = (null, null);
                }
            }
        }
        catch (SocketException)
        {
            // no multicast here: the port scan alone
        }

        return result;
    }

    private static string? Tag(string xml, string name)
    {
        var m = Regex.Match(xml, "<" + name + ">([^<]*)</" + name + ">");
        return m.Success ? WebUtility.HtmlDecode(m.Groups[1].Value).Trim() : null;
    }
}
