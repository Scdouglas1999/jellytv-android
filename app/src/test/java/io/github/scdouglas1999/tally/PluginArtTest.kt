package io.github.scdouglas1999.tally

import coil3.network.HttpException
import coil3.network.NetworkResponse
import coil3.size.Dimension
import coil3.size.Size
import io.github.scdouglas1999.tally.media.kit.ImageRetryInterceptor
import io.github.scdouglas1999.tally.media.kit.PluginArtInterceptor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketException

/** Contract 1 and 2 of 2.2 (plugin art at its drawn size, in the device's zone) and which failed loads are retried. */
class PluginArtTest {
    @Test
    fun `card and backdrop paths get w and tz, keeping their query`() {
        assertEquals(
            "http://10.0.2.2:18200/JellyTV/Card/4e1fce229ea70bae.png?v=c&n=Carolina%20Panthers&w=600&tz=America%2FNew_York",
            PluginArtInterceptor.pluginArtUrl(
                "http://10.0.2.2:18200/JellyTV/Card/4e1fce229ea70bae.png?v=c&n=Carolina%20Panthers",
                600,
                "America/New_York",
            ),
        )
        assertEquals(
            "https://example.org/jellyfin/JellyTV/Backdrop/401872948.png?w=1728&tz=Europe%2FBerlin",
            PluginArtInterceptor.pluginArtUrl("https://example.org/jellyfin/JellyTV/Backdrop/401872948.png", 1728, "Europe/Berlin"),
        )
        // a size that is not known yet: only the zone
        assertEquals(
            "http://h/JellyTV/Card/k.png?tz=UTC",
            PluginArtInterceptor.pluginArtUrl("http://h/JellyTV/Card/k.png", null, "UTC"),
        )
        // the zone is encoded as a query value (%2F); parameters already there are replaced, not repeated
        assertEquals(
            "http://h/JellyTV/Card/k.png?w=320&tz=UTC",
            PluginArtInterceptor.pluginArtUrl("http://h/JellyTV/Card/k.png?w=9999&tz=Asia/Tokyo", 320, "UTC"),
        )
    }

    @Test
    fun `other pictures are left alone`() {
        assertNull(PluginArtInterceptor.pluginArtUrl("http://h/Items/1/Images/Primary?maxWidth=300", 300, "UTC"))
        assertNull(PluginArtInterceptor.pluginArtUrl("http://h/JellyTV/Live/abc.m3u8", 300, "UTC"))
        assertNull(PluginArtInterceptor.pluginArtUrl("file:///data/x.png", 300, "UTC"))
    }

    @Test
    fun `drawn width in pixels, from the height for 16 by 9 art`() {
        assertEquals(600, PluginArtInterceptor.drawnWidth(Size(600, 338)))
        assertEquals(1920, PluginArtInterceptor.drawnWidth(Size(Dimension.Undefined, Dimension(1080))))
        assertNull(PluginArtInterceptor.drawnWidth(Size.ORIGINAL))
    }

    @Test
    fun `network failures and busy servers are retried, missing pictures are not`() {
        assertTrue(ImageRetryInterceptor.retryable(SocketException("Connection reset")))
        assertTrue(ImageRetryInterceptor.retryable(IOException("unexpected end of stream")))
        assertTrue(ImageRetryInterceptor.retryable(HttpException(NetworkResponse(code = 503))))
        assertTrue(ImageRetryInterceptor.retryable(HttpException(NetworkResponse(code = 429))))
        assertFalse(ImageRetryInterceptor.retryable(HttpException(NetworkResponse(code = 404))))
        assertFalse(ImageRetryInterceptor.retryable(IllegalStateException("cannot decode")))
    }
}
