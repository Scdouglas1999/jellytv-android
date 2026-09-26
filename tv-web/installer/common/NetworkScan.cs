using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Tally.Installer;

/// <summary>
/// This PC's home networks and a parallel scan of them: every address of each local IPv4 network (the /24 around this
/// PC's address) is asked at the same time, 96 at once. What is asked (Samsung's TV information and sdb port, LG's SSH
/// and key server ports) is the caller's probe.
/// </summary>
public static class NetworkScan
{
    /// <summary>This PC's IPv4 networks: (address, the /24 to scan).</summary>
    public static IReadOnlyList<(IPAddress Local, IReadOnlyList<IPAddress> Hosts)> LocalNetworks()
    {
        var result = new List<(IPAddress, IReadOnlyList<IPAddress>)>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
            {
                continue;
            }

            foreach (var unicast in nic.GetIPProperties().UnicastAddresses)
            {
                var ip = unicast.Address;
                if (ip.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ip) || IsLinkLocal(ip)
                    || !IsPrivate(ip) || result.Any(r => r.Item1.Equals(ip)))
                {
                    continue;
                }

                result.Add((ip, Slash24(ip).Where(h => !h.Equals(ip)).ToList()));
            }
        }

        return result;
    }

    public static IEnumerable<IPAddress> Slash24(IPAddress ip)
    {
        var b = ip.GetAddressBytes();
        for (var last = 1; last < 255; last++)
        {
            yield return new IPAddress([b[0], b[1], b[2], (byte)last]);
        }
    }

    public static bool IsLinkLocal(IPAddress ip) => ip.GetAddressBytes() is [169, 254, ..];

    /// <summary>Home networks (10/8, 172.16/12, 192.168/16, 100.64/10): a TV is never on a public address.</summary>
    public static bool IsPrivate(IPAddress ip) => ip.GetAddressBytes() switch
    {
        [10, ..] => true,
        [172, var b, ..] when b is >= 16 and <= 31 => true,
        [192, 168, ..] => true,
        [100, var b, ..] when b is >= 64 and <= 127 => true,
        _ => false,
    };

    /// <summary>Asks every address with <paramref name="probe"/>; returns what answered, in address order.</summary>
    public static async Task<IReadOnlyList<T>> ScanAsync<T>(IEnumerable<IPAddress> hosts,
        Func<IPAddress, CancellationToken, Task<T?>> probe, Func<T, IPAddress> addressOf, CancellationToken ct,
        IProgress<int>? progress = null)
        where T : class
    {
        var list = hosts.ToList();
        var found = new List<T>();
        var done = 0;
        using var gate = new SemaphoreSlim(96);
        var tasks = list.Select(async ip =>
        {
            await gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var answer = await probe(ip, ct).ConfigureAwait(false);
                if (answer is not null)
                {
                    lock (found)
                    {
                        found.Add(answer);
                    }
                }
            }
            finally
            {
                gate.Release();
                progress?.Report(Interlocked.Increment(ref done));
            }
        });
        await Task.WhenAll(tasks).ConfigureAwait(false);
        return found.OrderBy(t => addressOf(t).GetAddressBytes(), ByteOrder.Instance).ToList();
    }

    /// <summary>Whether <paramref name="port"/> takes a TCP connection within <paramref name="timeout"/>.</summary>
    public static async Task<bool> PortOpenAsync(IPAddress ip, int port, TimeSpan timeout, CancellationToken ct)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout);
        using var tcp = new TcpClient(ip.AddressFamily);
        try
        {
            await tcp.ConnectAsync(ip, port, limit.Token).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is SocketException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>The address this PC uses to reach <paramref name="tv"/>.</summary>
    public static IPAddress? LocalAddressFor(IPAddress tv)
    {
        try
        {
            using var socket = new Socket(tv.AddressFamily, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect(tv, 9); // UDP connect sends nothing; it only picks the route
            return (socket.LocalEndPoint as IPEndPoint)?.Address;
        }
        catch (SocketException)
        {
            return null;
        }
    }

    private sealed class ByteOrder : IComparer<byte[]>
    {
        public static readonly ByteOrder Instance = new();

        public int Compare(byte[]? x, byte[]? y)
        {
            for (var i = 0; i < Math.Min(x!.Length, y!.Length); i++)
            {
                var c = x[i].CompareTo(y[i]);
                if (c != 0)
                {
                    return c;
                }
            }

            return x.Length.CompareTo(y.Length);
        }
    }
}
