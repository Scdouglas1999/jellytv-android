using System;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Tally.Dvr;

/// <summary>
/// Whether a recording can be played from the library yet, as the apps are told (<c>libraryState</c> on every
/// recording object): <see cref="Ready"/> once it is a library item, <see cref="Adding"/> while a library covers its
/// file but Jellyfin has not picked it up, <see cref="NoLibrary"/> when no library covers the recordings folder.
/// </summary>
public static class RecordingLibrary
{
    public const string Ready = "ready";
    public const string Adding = "adding";
    public const string NoLibrary = "noLibrary";

    public static string State(string? itemId, bool covered)
        => !string.IsNullOrEmpty(itemId) ? Ready : covered ? Adding : NoLibrary;

    /// <summary>
    /// Creates the recordings library by itself the first time a finished recording has none, and only then: once it
    /// has done so (<paramref name="autoCreatedAt"/>), an owner who removes the library is not overruled. Returns the
    /// name of the library it created, or null when it did nothing.
    /// </summary>
    /// <param name="covered">Whether a library covers the finished recording's file right now.</param>
    /// <param name="autoCreatedAt">When the library was created this way before, if ever.</param>
    /// <param name="create">Creates the library and returns its name (DvrService.CreateLibraryAsync).</param>
    /// <param name="remember">Stores when it was created, before anything else can ask again.</param>
    public static async Task<string?> AutoCreateOnceAsync(Func<bool> covered, Func<DateTimeOffset?> autoCreatedAt, Func<Task<string>> create, Action<DateTimeOffset> remember)
    {
        if (autoCreatedAt() != null || covered())
        {
            return null;
        }

        var name = await create().ConfigureAwait(false);
        remember(DateTimeOffset.UtcNow);
        return name;
    }
}
