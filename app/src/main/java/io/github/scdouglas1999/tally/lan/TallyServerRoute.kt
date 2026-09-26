package io.github.scdouglas1999.tally.lan

import android.content.Context
import androidx.annotation.OptIn
import androidx.core.content.edit
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import com.github.damontecres.wholphin.WholphinApplication
import kotlinx.serialization.json.Json
import okhttp3.ConnectionPool
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import timber.log.Timber
import java.util.concurrent.TimeUnit

/**
 * The app-wide [ServerRouter] (seam in `AppModule.okHttpClient`: its [interceptor] is on the app's base OkHttp client,
 * so the Jellyfin SDK's API calls and websocket, images, playback, downloads and the Tally API all go through it).
 *
 * An object rather than a Hilt binding because the seam only adds lines to upstream's provider, and the router has
 * to be there before the first request (the session is restored with API calls before anything else starts). The
 * routes are kept in SharedPreferences: the interceptor reads them synchronously on its first request.
 */
object TallyServerRoute {
    @Volatile
    private var instance: ServerRouter? = null

    /** The sockets of the app's base OkHttp client (seam W68): those to an address found dead are closed. */
    val sockets: RouteSockets = RouteSockets()

    /**
     * The connection pool of the app's base OkHttp client (seam W68). Jellyfin (Kestrel) closes a keep-alive
     * connection after about two minutes of quiet; OkHttp keeps idle connections five minutes by default, so a
     * request on a connection kept longer found it reset ("Connection reset": blank pictures). Idle connections are
     * let go before the server does.
     */
    val connectionPool: ConnectionPool = ConnectionPool(MAX_IDLE_CONNECTIONS, KEEP_ALIVE_SECONDS, TimeUnit.SECONDS)

    private const val MAX_IDLE_CONNECTIONS = 5
    private const val KEEP_ALIVE_SECONDS = 90L

    /** The router, created on first use with the app's storage (memory only outside the app, e.g. unit tests). */
    val router: ServerRouter
        get() =
            instance ?: synchronized(this) {
                instance ?: ServerRouter(store(), sockets = sockets).also { instance = it }
            }

    val interceptor: Interceptor = Interceptor { chain -> router.interceptor.intercept(chain) }

    /**
     * The HTTP client of the multiview and corner players: through the route's interceptor and sockets like every
     * other request (its signed stream paths need no sign-in), so a dead or silent address is left within seconds.
     */
    private val streamClient: OkHttpClient by lazy {
        OkHttpClient
            .Builder()
            .addInterceptor(interceptor)
            .socketFactory(sockets)
            .connectionPool(connectionPool)
            .build()
    }

    /** Media3's default media sources, with streams opened through the route ([RoutedDataSource], [streamClient]). */
    @OptIn(UnstableApi::class)
    fun mediaSources(context: Context): MediaSource.Factory =
        DefaultMediaSourceFactory(
            RoutedDataSource.Factory(DefaultDataSource.Factory(context, OkHttpDataSource.Factory(streamClient))),
        )

    private fun store(): RouteStore {
        val context =
            try {
                WholphinApplication.instance.applicationContext
            } catch (e: Exception) {
                null
            } ?: return MemoryRouteStore()
        return PreferencesRouteStore(context)
    }
}

/** [RouteStore] in the app's SharedPreferences, as one JSON value. */
private class PreferencesRouteStore(
    context: Context,
) : RouteStore {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    override fun load(): Map<String, StoredRoute> =
        prefs.getString(KEY, null)?.let {
            try {
                json.decodeFromString<Map<String, StoredRoute>>(it)
            } catch (e: Exception) {
                Timber.w(e, "Stored server routes unreadable, starting over")
                null
            }
        } ?: emptyMap()

    override fun save(routes: Map<String, StoredRoute>) {
        prefs.edit { putString(KEY, json.encodeToString(routes)) }
    }

    private companion object {
        const val PREFS = "tally_server_routes"
        const val KEY = "routes"
    }
}
