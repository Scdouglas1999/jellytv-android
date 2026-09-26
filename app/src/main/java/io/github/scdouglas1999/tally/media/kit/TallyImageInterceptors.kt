package io.github.scdouglas1999.tally.media.kit

import coil3.ComponentRegistry
import coil3.intercept.Interceptor
import coil3.network.HttpException
import coil3.request.ErrorResult
import coil3.request.ImageResult
import coil3.size.Dimension
import coil3.size.Size
import kotlinx.coroutines.delay
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import timber.log.Timber
import java.io.IOException
import java.time.ZoneId

/**
 * Tally's additions to the app's image loader (seam in upstream's `CoilConfig`), so they apply to every picture on
 * every screen, TV and phone, without each card having to ask:
 *  - [PluginArtInterceptor]: the plugin's game art is requested at the size it is drawn and in the device's time zone;
 *  - [ImageRetryInterceptor]: a picture whose load fails on the way ("Connection reset", a server that is busy) is
 *    asked for again a few times with a growing pause. A picture that still fails is asked for again whenever its
 *    card is drawn again (a row scrolled back into view starts a new request: Coil keeps no failures).
 */
object TallyImageInterceptors {
    fun addTo(components: ComponentRegistry.Builder) {
        // the retry wraps the art rewrite, so every attempt asks for the same (rewritten) picture
        components.add(ImageRetryInterceptor())
        components.add(PluginArtInterceptor())
    }
}

/**
 * The plugin's game art (`/JellyTV/Card/{key}.png`, `/JellyTV/Backdrop/{gameId}.png`) with `w` (the width it is
 * drawn at, in pixels: the server scales and caches the art in a few steps) and `tz` (the device's time zone, for the
 * times drawn into a card). Plugins that do not know them ignore them.
 */
class PluginArtInterceptor(
    private val zone: () -> String = { ZoneId.systemDefault().id },
) : Interceptor {
    override suspend fun intercept(chain: Interceptor.Chain): ImageResult {
        val data = chain.request.data
        val url = (data as? String) ?: (data as? coil3.Uri)?.toString() ?: return chain.proceed()
        val sized = pluginArtUrl(url, drawnWidth(chain.size), zone()) ?: return chain.proceed()
        if (sized == url) return chain.proceed()
        return chain
            .withRequest(
                chain.request
                    .newBuilder()
                    .data(sized)
                    .build(),
            ).proceed()
    }

    companion object {
        /** The width a picture is drawn at, in pixels; from the height for 16:9 art laid out by height only. */
        internal fun drawnWidth(size: Size): Int? {
            (size.width as? Dimension.Pixels)?.px?.takeIf { it > 0 }?.let { return it }
            return (size.height as? Dimension.Pixels)?.px?.takeIf { it > 0 }?.let { it * 16 / 9 }
        }

        /**
         * [url] with `w` = [widthPx] (when known) and `tz` = [zone] when it is plugin game art (the query it already
         * has is kept; `w` and `tz` are replaced), else null.
         */
        internal fun pluginArtUrl(
            url: String,
            widthPx: Int?,
            zone: String?,
        ): String? {
            val parsed = url.toHttpUrlOrNull() ?: return null
            val path = parsed.encodedPath
            val isArt =
                (path.contains("/JellyTV/Card/") || path.contains("/JellyTV/Backdrop/")) && path.endsWith(".png")
            if (!isArt) return null
            val builder = parsed.newBuilder()
            if (widthPx != null && widthPx > 0) builder.setQueryParameter("w", widthPx.toString())
            if (!zone.isNullOrBlank()) builder.setQueryParameter("tz", zone)
            return builder.build().toString()
        }
    }
}

/**
 * Loads that fail on the way (an I/O error, or the server answering 408, 429 or 5xx) are tried again after
 * [ImageRetryDelays] (three more tries within about 6 seconds). A 404 or a picture that cannot be decoded is not.
 */
class ImageRetryInterceptor(
    private val delays: List<Long> = ImageRetryDelays,
) : Interceptor {
    override suspend fun intercept(chain: Interceptor.Chain): ImageResult {
        var result = chain.proceed()
        for (wait in delays) {
            val error = result as? ErrorResult ?: return result
            if (!retryable(error.throwable) || !isNetwork(chain.request.data)) return result
            Timber.d("Image load failed (%s), trying again in %d ms: %s", error.throwable.toString(), wait, chain.request.data)
            delay(wait)
            result = chain.proceed()
        }
        return result
    }

    companion object {
        internal fun retryable(error: Throwable): Boolean =
            when (error) {
                is HttpException -> error.response.code.let { it == 408 || it == 429 || it >= 500 }
                is IOException -> true
                else -> false
            }

        private fun isNetwork(data: Any): Boolean {
            val text = (data as? String) ?: (data as? coil3.Uri)?.toString() ?: return false
            return text.startsWith("http://", ignoreCase = true) || text.startsWith("https://", ignoreCase = true)
        }
    }
}

/** The pauses before each new try of a failed picture. */
internal val ImageRetryDelays = listOf(500L, 1_500L, 4_000L)
