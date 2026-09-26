package io.github.scdouglas1999.tally.dvr.ui

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import com.github.damontecres.wholphin.ui.tryRequestFocus

/**
 * Keeps focus on the Recordings tab when the entry that has it leaves the list: a recording that finishes moves
 * from RECORDING NOW to RECORDED, a scheduled game starts recording, a job is canceled or dismissed. Removing the
 * focused element left nothing focused, and the next key (or the page) put focus on the drawer.
 *
 * Every focusable entry is registered under its key ([recordingsEntry]); the list reports its keys in display order and the
 * lazy item each one is in ([layout]). When the list loses focus because its focused entry left the composition
 * (not because the viewer moved away: that entry is still there), focus goes to the same job in its new place, else
 * to the entry now at its position, else to [fallback] (the tab, when the list is empty).
 */
class RecordingsFocus {
    private val requesters = HashMap<String, FocusRequester>()

    /** The entries drawn now: one token per drawn element (a job moving between sections is drawn anew). */
    private val attached = HashSet<Any>()

    /** The focus keys in display order and the lazy item each is drawn in, as the list last laid them out. */
    private var order: List<String> = emptyList()
    private var previousOrder: List<String> = emptyList()
    private var lazyIndex: Map<String, Int> = emptyMap()

    private var focusedKey: String? = null
    private var focusedToken: Any? = null
    private var listHasFocus = false

    /** Set when the list lost focus; the check runs a frame later, once the removed entries are gone. */
    private var lost: Lost? = null

    private class Lost(
        val key: String,
        val index: Int,
        val token: Any?,
    )

    internal var checks by mutableIntStateOf(0)
        private set

    fun requester(key: String): FocusRequester = requesters.getOrPut(key) { FocusRequester() }

    fun layout(
        keys: List<String>,
        lazyIndexOf: Map<String, Int>,
    ) {
        if (keys != order) {
            previousOrder = order
            order = keys
        }
        lazyIndex = lazyIndexOf
    }

    internal fun onListFocus(hasFocus: Boolean) {
        if (listHasFocus && !hasFocus) {
            val key = focusedKey
            if (key != null) {
                // the list may already be the new one (the entry left it): its place in the one before
                val index = order.indexOf(key).takeIf { it >= 0 } ?: previousOrder.indexOf(key)
                lost = Lost(key, index, focusedToken)
                checks++
            }
        }
        listHasFocus = hasFocus
    }

    internal fun onEntryFocused(
        key: String,
        token: Any,
    ) {
        focusedKey = key
        focusedToken = token
    }

    internal fun onAttach(token: Any) {
        attached += token
    }

    internal fun onDetach(token: Any) {
        attached -= token
    }

    /**
     * Where focus goes after [lost] left: null when it did not leave the list (the viewer moved to the tabs or the
     * drawer: the entry is still drawn) or focus is back in the list already.
     */
    internal fun target(): String? {
        val gone = lost ?: return null
        lost = null
        val key = gone.key
        val index = gone.index
        if (listHasFocus || gone.token in attached) return null
        if (key in order) return key
        if (order.isEmpty()) return FALLBACK
        return order[index.coerceIn(0, order.size - 1)]
    }

    internal fun lazyIndexOf(key: String): Int? = lazyIndex[key]

    companion object {
        /** The target when the list has nothing left to focus: the fallback (the selected tab). */
        const val FALLBACK = "\u0000fallback"
    }
}

/** Registers a focusable entry of the Recordings list under [key] (a job or rule id). */
@Composable
fun Modifier.recordingsEntry(
    focus: RecordingsFocus,
    key: String,
): Modifier {
    val token = remember(focus, key) { Any() }
    DisposableEffect(token) {
        focus.onAttach(token)
        onDispose { focus.onDetach(token) }
    }
    return this
        .focusRequester(focus.requester(key))
        .onFocusChanged { if (it.isFocused) focus.onEntryFocused(key, token) }
}

/** On the list itself: tells [focus] when focus leaves it. */
fun Modifier.recordingsList(focus: RecordingsFocus): Modifier = onFocusChanged { focus.onListFocus(it.hasFocus) }

/** Puts focus back after its entry left the list ([RecordingsFocus]); scrolls to the entry first when it is not drawn. */
@Composable
fun RecordingsFocusEffect(
    focus: RecordingsFocus,
    listState: LazyListState,
    fallback: FocusRequester?,
) {
    val checks = focus.checks
    LaunchedEffect(checks) {
        if (checks == 0) return@LaunchedEffect
        // after the frame that removed the entry: its disposal has run and the new entries are laid out
        withFrameNanos { }
        val key = focus.target() ?: return@LaunchedEffect
        if (key == RecordingsFocus.FALLBACK) {
            fallback?.tryRequestFocus("tally-recordings-fallback")
            return@LaunchedEffect
        }
        if (focus.requester(key).tryRequestFocus("tally-recordings-keep")) return@LaunchedEffect
        val index = focus.lazyIndexOf(key)
        if (index != null) {
            listState.scrollToItem(index)
            withFrameNanos { }
            if (focus.requester(key).tryRequestFocus("tally-recordings-keep")) return@LaunchedEffect
        }
        fallback?.tryRequestFocus("tally-recordings-fallback")
    }
}

/** The [RecordingsFocus] of one Recordings tab. */
@Composable
fun rememberRecordingsFocus(): RecordingsFocus = remember { RecordingsFocus() }
