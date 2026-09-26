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

    /// <summary>The state apps are told. An item id only counts while a library covers the file: when the library is
    /// removed, Jellyfin drops its items without telling anyone about each one, so a remembered id may name an item
    /// that is gone.</summary>
    public static string State(string? itemId, bool covered)
        => !covered ? NoLibrary : !string.IsNullOrEmpty(itemId) ? Ready : Adding;

    /// <summary>
    /// The library item a finished recording has now: none while no library covers its file (a removed library
    /// takes its items along, and Jellyfin raises no ItemRemoved for them, only for the library's own folders), the
    /// remembered one while Jellyfin still has it, else the one Jellyfin holds for the file (a library made, or a
    /// scan run, since).
    /// </summary>
    /// <param name="itemId">The item id the recording remembers.</param>
    /// <param name="covered">Whether a library covers the recording's file right now.</param>
    /// <param name="exists">Whether Jellyfin still has an item with that id.</param>
    /// <param name="findByPath">The id of the item Jellyfin has for the file, if any.</param>
    public static string? Reconcile(string? itemId, bool covered, Func<string, bool> exists, Func<string?> findByPath)
    {
        if (!covered)
        {
            return null;
        }

        return !string.IsNullOrEmpty(itemId) && exists(itemId) ? itemId : findByPath();
    }

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
