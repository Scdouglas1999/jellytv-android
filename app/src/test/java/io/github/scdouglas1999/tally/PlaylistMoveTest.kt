package io.github.scdouglas1999.tally

import io.github.scdouglas1999.tally.media.playlist.PlaylistMove
import org.jellyfin.sdk.model.ServerVersion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

/**
 * Jellyfin 10.10's playlist Move and the calls that make it land right. [land1010] is the server's behavior as
 * measured on 10.10.6 (tally dev server, a playlist of five, every from/to; shots/plmove.py); the planner is checked
 * against it for every move one place up or down, in lists of two to seven entries.
 */
class PlaylistMoveTest {
    /** Where 10.10.6 puts [item] when asked to move it to [sent]: the prior entry is [sent] (moving down) or the one before it, and the entry goes after it. */
    private fun <T> land1010(
        order: List<T>,
        item: T,
        sent: Int,
    ): List<T> {
        val from = order.indexOf(item)
        if (from == sent) return order
        val prior = if (sent > from) sent else maxOf(sent - 1, 0)
        require(prior < order.size) { "HTTP 500" }
        val rest = order - item
        return if (sent >= rest.size) rest + item else rest.toMutableList().apply { add(prior + 1, item) }
    }

    /** Every (from, sent) -> landed index measured on 10.10.6 with five entries. */
    private val measured =
        mapOf(
            (0 to 1) to 2,
            (0 to 2) to 3,
            (0 to 3) to 4,
            (0 to 4) to 4,
            (1 to 0) to 1,
            (1 to 2) to 3,
            (1 to 3) to 4,
            (1 to 4) to 4,
            (2 to 0) to 1,
            (2 to 1) to 1,
            (2 to 3) to 4,
            (2 to 4) to 4,
            (3 to 0) to 1,
            (3 to 1) to 1,
            (3 to 2) to 2,
            (3 to 4) to 4,
            (4 to 0) to 1,
            (4 to 1) to 1,
            (4 to 2) to 2,
            (4 to 3) to 3,
            (0 to 0) to 0,
            (0 to -1) to 1,
            (2 to -1) to 1,
        )

    @Test
    fun `the model matches what the server did`() {
        val order = listOf("a", "b", "c", "d", "e")
        measured.forEach { (move, landed) ->
            val (from, sent) = move
            val item = order[from]
            assertEquals("from $from sent $sent", landed, land1010(order, item, sent).indexOf(item))
        }
    }

    @Test
    fun `planned calls move one place up or down on 10_10`() {
        for (size in 2..7) {
            val ids = List(size) { UUID(0, it.toLong()) }
            for (index in 0 until size) {
                for (up in listOf(true, false)) {
                    val target = if (up) index - 1 else index + 1
                    val steps = PlaylistMove.plan(size, index, up) { ids.getOrNull(it) }
                    if (target !in 0 until size) {
                        assertNull(steps)
                        continue
                    }
                    var order = ids
                    steps!!.forEach { order = land1010(order, it.itemId, it.newIndex) }
                    val expected = ids.toMutableList().apply { add(target, removeAt(index)) }
                    assertEquals("size $size, $index ${if (up) "up" else "down"}: $steps", expected, order)
                }
            }
        }
    }

    @Test
    fun `a neighbor that is not loaded leaves it to upstream`() {
        val ids = List(5) { UUID(0, it.toLong()) }
        assertNull(PlaylistMove.plan(5, 2, up = false) { if (it == 3) null else ids[it] })
    }

    @Test
    fun `only 10_10 servers are compensated`() {
        assertTrue(PlaylistMove.offByOne(ServerVersion(10, 10, 6)))
        assertFalse(PlaylistMove.offByOne(ServerVersion(10, 11, 0)))
        assertFalse(PlaylistMove.offByOne(ServerVersion(12, 1, 0)))
        assertFalse(PlaylistMove.offByOne(null))
    }
}
