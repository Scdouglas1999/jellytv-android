using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Tally.Client;
using Jellyfin.Plugin.Tally.Services;

namespace Jellyfin.Plugin.Tally.Dvr;

/// <summary>Board module: each game with a DVR job gains <c>recording</c> (state, job, start-over playlist while it
/// records, library item once done, reason). Games without one are untouched. Its presence in /info's features
/// ("dvr") tells clients the server records.</summary>
public sealed class DvrEnricher : IBoardEnricher
{
    private readonly DvrService _dvr;
    private readonly StreamSigner _signer;

    public DvrEnricher(DvrService dvr, StreamSigner signer)
    {
        _dvr = dvr;
        _signer = signer;
    }

    public string Name => "dvr";

    public int Order => 20;

    public bool IsEnabled => true;

    public Task EnrichAsync(BoardContext context, CancellationToken cancellationToken)
    {
        if (!_dvr.HasAnything)
        {
            return Task.CompletedTask;
        }

        // Jellyfin's libraries are read at most once per board, and only for a recording that is not a library item yet
        var states = new System.Lazy<System.Func<RecordingJob, string>>(_dvr.LibraryStates);
        foreach (var g in context.Board.Games)
        {
            g.Recording = _dvr.ForGame(g.Id, id => StartOverPath(_signer, id), job => states.Value(job));
        }

        return Task.CompletedTask;
    }

    /// <summary>Root-relative, signed like the channel addresses: anonymous players (multiview, native players handed a
    /// URL) can open it, nobody can guess one.</summary>
    public static string StartOverPath(StreamSigner signer, System.Guid jobId)
    {
        var id = jobId.ToString("N");
        return $"/JellyTV/Recordings/{id}/playlist.m3u8?s={Sign(signer, id)}";
    }

    public static string Sign(StreamSigner signer, string jobId) => signer.Sign("rec:" + jobId, string.Empty);
}
