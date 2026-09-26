package io.github.scdouglas1999.tally.ui.player.controls.phone

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.os.Handler
import android.os.Looper
import android.view.ViewTreeObserver
import android.view.Window
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsIgnoringVisibility
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import io.github.scdouglas1999.tally.ui.formfactor.TallyFormFactor

/**
 * The player's window on a phone (seam W37 at the top of `PlaybackPage`, and the post-play page): landscape (either
 * way up, by the sensor) and full screen with the status and navigation bars hidden (a swipe from an edge shows them
 * for a moment) while it is shown; the orientation and the bars in effect before come back when it leaves. Nothing on
 * a TV.
 *
 * Held by a count, and let go a moment late: when the player hands over to the post-play page (both landscape) the
 * phone does not turn to portrait and back in between.
 */
@Composable
fun PhonePlayerWindow() {
    val context = LocalContext.current
    DisposableEffect(context) {
        val activity = context.findActivity()
        if (activity == null || TallyFormFactor.of(context) != TallyFormFactor.PHONE) {
            return@DisposableEffect onDispose { }
        }
        PlayerWindowHold.acquire(activity)
        onDispose { PlayerWindowHold.release(activity) }
    }
}

/**
 * Inside a dialog window shown over the phone player (a [io.github.scdouglas1999.tally.ui.phone.PhoneSheet], a menu):
 * while the player's window is held ([PhonePlayerWindow]), the status and navigation bars stay hidden in the dialog's
 * window too. A new window that takes the focus brings the bars back otherwise, until it closes: they are hidden when
 * the dialog appears, again whenever its window gains the focus (some phones show them only then), and in the player's
 * window when the dialog closes. Nothing anywhere else (the player not shown, a TV).
 */
@Composable
fun KeepPlayerBarsHidden() {
    val view = LocalView.current
    DisposableEffect(view) {
        val window = (view.parent as? DialogWindowProvider)?.window ?: return@DisposableEffect onDispose { }
        val decor = window.decorView
        val hide = Runnable { if (PlayerWindowHold.held) hideBars(window) }
        hide.run()
        // once the window is laid out and focused, in case showing it brought the bars back
        decor.post(hide)
        val focus = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus -> if (hasFocus) hide.run() }
        decor.viewTreeObserver.addOnWindowFocusChangeListener(focus)
        onDispose {
            decor.removeCallbacks(hide)
            decor.viewTreeObserver.takeIf { it.isAlive }?.removeOnWindowFocusChangeListener(focus)
            // back in the player's window: bars the dialog brought back go away with it
            val activity = view.context.findActivity()
            if (activity != null && PlayerWindowHold.held) hideBars(activity.window)
        }
    }
}

private fun hideBars(window: Window) {
    WindowCompat.getInsetsController(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.systemBars())
    }
}

/**
 * The status bar's height, also while the player hides it: the strip at the top where a swipe brings the bars back
 * and a tap may not reach the app. The player's top bar starts under it ([playerTopBarInset]).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun playerStatusStrip(): Dp = WindowInsets.statusBarsIgnoringVisibility.asPaddingValues().calculateTopPadding()

/** Top padding of [playerStatusStrip]: a landscape player's top bar (back, title, buttons) sits clear of the strip. */
@Composable
fun Modifier.playerTopBarInset(): Modifier = padding(top = playerStatusStrip())

private object PlayerWindowHold {
    /** How long the window stays as it is after the last holder leaves, in case another takes it straight away. */
    private const val RELEASE_DELAY_MS = 350L

    private val handler = Handler(Looper.getMainLooper())
    private var holders = 0
    private var previousOrientation: Int? = null
    private var pendingRelease: Runnable? = null

    /** The player's window is held (landscape, bars hidden), or is about to be let go. */
    val held: Boolean
        get() = holders > 0

    fun acquire(activity: Activity) {
        pendingRelease?.let { handler.removeCallbacks(it) }
        pendingRelease = null
        if (holders == 0 && previousOrientation == null) {
            previousOrientation = activity.requestedOrientation
        }
        holders++
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        hideBars(activity.window)
    }

    fun release(activity: Activity) {
        holders = (holders - 1).coerceAtLeast(0)
        if (holders > 0) return
        val restore =
            Runnable {
                pendingRelease = null
                if (holders > 0) return@Runnable
                insetsController(activity).show(WindowInsetsCompat.Type.systemBars())
                previousOrientation?.let { activity.requestedOrientation = it }
                previousOrientation = null
            }
        pendingRelease = restore
        handler.postDelayed(restore, RELEASE_DELAY_MS)
    }

    private fun insetsController(activity: Activity): WindowInsetsControllerCompat =
        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
}

private tailrec fun Context.findActivity(): Activity? =
    when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }
