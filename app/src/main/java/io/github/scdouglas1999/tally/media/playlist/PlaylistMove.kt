package io.github.scdouglas1999.tally.media.playlist

import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.extensions.playlistsApi
import org.jellyfin.sdk.model.ServerVersion
import timber.log.Timber
import java.util.UUID

/**
 * Moving a playlist entry one place up or down on Jellyfin 10.10 (seam in upstream's `PlaylistViewModel.onMoveItem`).
 *
 * 10.10's `POST /Playlists/{id}/Items/{itemId}/Move/{newIndex}` lands one place off. Measured on 10.10.6 (a playlist
 * of five, every from/to): moving an entry down to `n` puts it at `n + 1` (the last place excepted), asking for its
 * own place does nothing, and moving it up to `0` puts it at `1`; moving up to any other place is right. So one call
 * cannot move an entry down by one or to the top. [plan] finds calls that can: the entry below moves up instead, or
 * the entry goes two down and one back up. Servers from 10.11 on take the request as it is.
 */
object PlaylistMove {
    /** One call of the Move endpoint: [itemId] to [newIndex]. */
    data class Step(
        val itemId: UUID,
        val newIndex: Int,
    )

    /** Whether [version] has the off-by-one Move (10.10.x). Unknown versions are taken at their word. */
    fun offByOne(version: ServerVersion?): Boolean = version != null && version.major == 10 && version.minor == 10

    /**
     * The 10.10 calls that move the entry at [index] of a playlist of [size] entries one place up ([up]) or down,
     * given the ids of its entries ([idAt], null for one not loaded). Null when it cannot be planned (a neighbor that
     * is needed is not loaded, or the move leaves the list).
     */
    fun plan(
        size: Int,
        index: Int,
        up: Boolean,
        idAt: (Int) -> UUID?,
    ): List<Step>? {
        if (index !in 0 until size) return null
        return if (up) {
            if (index == 0) return null
            val target = index - 1
            if (target >= 1) {
                listOf(Step(idAt(index) ?: return null, target))
            } else {
                // to the top: the entry at the top goes one down instead
                oneDown(size, 0, idAt)
            }
        } else {
            if (index >= size - 1) return null
            oneDown(size, index, idAt)
        }
    }

    /** The entry at [index] one place down (not the last place). */
    private fun oneDown(
        size: Int,
        index: Int,
        idAt: (Int) -> UUID?,
    ): List<Step>? {
        val item = idAt(index) ?: return null
        return when {
            // to the last place: the server appends, which is right
            index + 1 == size - 1 -> listOf(Step(item, size - 1))

            // the entry below moves up into its place (moving up is right, except to the top)
            index >= 1 -> listOf(Step(idAt(index + 1) ?: return null, index))

            // from the top: two down (asking for 1 lands at 2), then one back up to 1
            else -> listOf(Step(item, 1), Step(item, 1))
        }
    }

    /**
     * On a 10.10 server, moves the entry at [index] one place up or down with [plan]'s calls and returns true.
     * False when the server is not 10.10 or the move cannot be planned: upstream's single call is made instead.
     */
    suspend fun moveOnOffByOneServer(
        api: ApiClient,
        serverVersion: ServerVersion?,
        playlistId: UUID,
        size: Int,
        index: Int,
        up: Boolean,
        idAt: (Int) -> UUID?,
    ): Boolean {
        if (!offByOne(serverVersion)) return false
        val steps = plan(size, index, up, idAt) ?: return false
        Timber.i("Playlist move on %s: %s", serverVersion, steps)
        steps.forEach { step ->
            api.playlistsApi.moveItem(
                playlistId = playlistId.toString().replace("-", ""),
                itemId = step.itemId.toString().replace("-", ""),
                newIndex = step.newIndex,
            )
        }
        return true
    }
}
