package io.github.scdouglas1999.tally.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import io.github.scdouglas1999.tally.ui.formfactor.TallyFormFactor
import timber.log.Timber

/**
 * The video player's media notification on a phone (seams in upstream's `PlaybackViewModel`: the session is created,
 * the player is let go). Upstream's video session is a plain Media3 [MediaSession], which Android shows nowhere: on a
 * phone it is served by [TallyVideoPlaybackService] while the player is on screen, so the notification shade and the
 * lock screen show what plays, with its picture ([SessionArtwork]: the download's own artwork when the item is
 * downloaded, so it shows offline too; else the server's). The player page lets its player go when it stops, so this
 * never plays video in the background. Nothing on a TV.
 */
object TallyVideoPlayback {
    /** How long the service waits after the player let its session go, in case the next one follows (another game). */
    private const val STOP_DELAY_MS = 1_000L

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    internal var session: MediaSession? = null

    @Volatile
    internal var service: TallyVideoPlaybackService? = null

    private val artwork = SessionArtwork()

    private val stop = Runnable { if (session == null) service?.stopSelf() }

    /** Upstream created the video player's session. */
    fun onSessionCreated(
        context: Context,
        mediaSession: MediaSession,
    ) {
        if (TallyFormFactor.of(context) != TallyFormFactor.PHONE) return
        val appContext = context.applicationContext
        onMain {
            main.removeCallbacks(stop)
            session = mediaSession
            SessionArtwork.appContext = appContext
            artwork.attach(mediaSession)
            val running = service
            if (running != null) {
                running.attach(mediaSession)
                return@onMain
            }
            try {
                appContext.startService(Intent(appContext, TallyVideoPlaybackService::class.java))
            } catch (e: IllegalStateException) {
                // not allowed from the background: the video plays without a notification, as upstream
                Timber.w(e, "Could not start the video playback service")
            }
        }
    }

    /** Upstream is about to release [mediaSession] (the player is let go): out of the service, which then stops. */
    fun onSessionReleasing(mediaSession: MediaSession?) {
        if (mediaSession == null) return
        // before upstream releases it: the service lets it go while it is still a working session
        onMain {
            if (session !== mediaSession) return@onMain
            artwork.detach()
            session = null
            service?.removeSessions()
            main.postDelayed(stop, STOP_DELAY_MS)
        }
    }

    /** Runs [block] now on the main thread (where upstream's player lives), else posts it there. */
    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }
}

/**
 * Serves the video player's session to the system (notification, lock screen, headset controls) while the player is
 * on screen. It never creates a player of its own; tapping the notification opens the app.
 */
@OptIn(UnstableApi::class)
class TallyVideoPlaybackService : MediaSessionService() {
    override fun onCreate() {
        super.onCreate()
        TallyVideoPlayback.service = this
        val session = TallyVideoPlayback.session
        if (session == null) {
            stopSelf()
        } else {
            attach(session)
        }
    }

    internal fun attach(session: MediaSession) {
        launchIntent()?.let { session.setSessionActivity(it) }
        if (!isSessionAdded(session)) addSession(session)
    }

    internal fun removeSessions() {
        sessions.forEach { removeSession(it) }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = TallyVideoPlayback.session

    override fun onTaskRemoved(rootIntent: Intent?) {
        removeSessions()
        stopSelf()
    }

    override fun onDestroy() {
        removeSessions()
        if (TallyVideoPlayback.service === this) TallyVideoPlayback.service = null
        super.onDestroy()
    }

    private fun launchIntent(): PendingIntent? {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        // as a tap on the launcher icon: the app's task comes back as it was
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
        return PendingIntent.getActivity(
            this,
            1,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
