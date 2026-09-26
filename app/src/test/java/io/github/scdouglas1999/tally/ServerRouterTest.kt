package io.github.scdouglas1999.tally

import com.sun.net.httpserver.HttpServer
import io.github.scdouglas1999.tally.lan.MemoryRouteStore
import io.github.scdouglas1999.tally.lan.RouteRecovery
import io.github.scdouglas1999.tally.lan.RouteSockets
import io.github.scdouglas1999.tally.lan.ServerRouter
import io.github.scdouglas1999.tally.lan.StoredAddress
import io.github.scdouglas1999.tally.lan.StoredRoute
import io.github.scdouglas1999.tally.lan.isHomeHost
import io.github.scdouglas1999.tally.lan.normalizeBase
import io.github.scdouglas1999.tally.lan.normalizeServerId
import io.github.scdouglas1999.tally.lan.rebase
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class ServerRouterTest {
    private val serverId = "6cc26f6bbc534181a937364479f2910d"
    private val otherId = "0123456789abcdef0123456789abcdef"
    private val servers = mutableListOf<HttpServer>()

    @After
    fun stopAll() {
        servers.forEach { it.stop(0) }
    }

    /** A fake Jellyfin at 127.0.0.1:<free port>: `/System/Info/Public` answers [id], other paths answer [name]. */
    private fun fake(
        name: String,
        id: String = serverId,
        localAddress: String? = null,
        port: Int = 0,
    ): Pair<HttpServer, String> {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
        server.createContext("/") { exchange ->
            val body =
                if (exchange.requestURI.path.endsWith("/System/Info/Public")) {
                    val local = localAddress?.let { ""","LocalAddress":"$it"""" } ?: ""
                    """{"Id":"$id","ServerName":"$name"$local}"""
                } else {
                    "$name ${exchange.requestMethod} ${exchange.requestURI}"
                }
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        servers += server
        return server to "http://127.0.0.1:${server.address.port}"
    }

    /** An address nothing listens on (a server started and stopped). */
    private fun deadAddress(): String {
        val (server, base) = fake("dead")
        server.stop(0)
        servers -= server
        return base
    }

    /** 127.0.0.1 is a home host: here only the addresses learned as home are, as on a real network. */
    private fun router(store: MemoryRouteStore = MemoryRouteStore()) = ServerRouter(store, homeHost = { false })

    private fun client(router: ServerRouter) = OkHttpClient.Builder().addInterceptor(router.interceptor).build()

    private fun OkHttpClient.get(url: String): String = newCall(Request.Builder().url(url).build()).execute().use { it.body.string() }

    @Test
    fun homeHosts() {
        listOf("192.168.1.50", "10.0.2.2", "172.17.0.3", "127.0.0.1", "169.254.1.1", "nas.local", "jellyfin", "[fd00::1]")
            .forEach { assertTrue(it, isHomeHost(it)) }
        listOf("203.0.113.10", "100.64.0.1", "172.32.0.1", "8.8.8.8", "example.org", "10.0.2.2.sslip.io", "[2001:db8::1]")
            .forEach { assertFalse(it, isHomeHost(it)) }
    }

    @Test
    fun addressesAndIds() {
        assertEquals("http://192.168.1.50:9000", normalizeBase(" http://192.168.1.50:9000/ "))
        assertEquals("https://example.org/jellyfin", normalizeBase("https://example.org/jellyfin/?x=1#y"))
        assertNull(normalizeBase("ftp://example.org"))
        assertEquals(serverId, normalizeServerId("6CC26F6B-BC53-4181-A937-364479F2910D"))
        assertEquals(serverId, normalizeServerId(UUID.fromString("6cc26f6b-bc53-4181-a937-364479f2910d")))
        assertNull(normalizeServerId("nope"))
    }

    @Test
    fun rebaseKeepsPathAndQuery() {
        val moved =
            rebase(
                "https://example.org/jellyfin/Videos/1/stream?static=true".toHttpUrl(),
                "https://example.org/jellyfin".toHttpUrl(),
                "http://192.168.1.50:9000".toHttpUrl(),
            )
        assertEquals("http://192.168.1.50:9000/Videos/1/stream?static=true", moved.toString())
        val back =
            rebase(
                "http://192.168.1.50:9000/socket?api_key=x".toHttpUrl(),
                "http://192.168.1.50:9000".toHttpUrl(),
                "https://example.org/jellyfin".toHttpUrl(),
            )
        assertEquals("https://example.org/jellyfin/socket?api_key=x", back.toString())
    }

    @Test
    fun prefersHomeAddressThatAnswers() {
        val (_, public) = fake("public")
        val (_, home) = fake("home")
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, home, home = true)
        assertTrue(router.evaluate(serverId))
        assertEquals(home, router.activeAddress(serverId))
        assertTrue(router.status.value[serverId]!!.home)
        // requests built with the saved (public) address go home
        assertEquals("home GET /Items?x=1", client(router).get("$public/Items?x=1"))
    }

    @Test
    fun savedAddressWhenHomeDoesNotAnswer() {
        val (_, public) = fake("public")
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, deadAddress(), home = true)
        assertTrue(router.evaluate(serverId))
        assertEquals(public, router.activeAddress(serverId))
        assertFalse(router.status.value[serverId]!!.home)
        assertFalse(router.onPreferred(serverId))
    }

    @Test
    fun failsOverMidRequestAndSwitchesBack() {
        val (publicServer, public) = fake("public")
        val router = router()
        router.register(serverId, public)
        val homeDeadFirst = deadAddress()
        router.learn(serverId, homeDeadFirst, home = true)
        assertTrue(router.evaluate(serverId))
        assertEquals(public, router.activeAddress(serverId))

        // the home server comes up at another address it reports as its LocalAddress; the public one dies
        val (_, home) = fake("home")
        router.learn(serverId, home, home = true)
        publicServer.stop(0)
        val http = client(router)
        assertEquals("home GET /Videos/1/stream", http.get("$public/Videos/1/stream"))
        assertEquals(home, router.activeAddress(serverId))

        // the public one returns: still home (preferred); home dies: back to the public address
        val (_, public2) = fake("public-again")
        router.register(serverId, public2)
        servers.first { it.address.port == home.substringAfterLast(':').toInt() }.stop(0)
        assertEquals("public-again GET /Items", http.get("$public2/Items"))
        assertEquals(public2, router.activeAddress(serverId))
    }

    @Test
    fun switchesBackWhenHomeReturns() {
        val (_, public) = fake("public")
        val (homeServer, home) = fake("home")
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, home, home = true)
        assertTrue(router.evaluate(serverId))
        assertEquals(home, router.activeAddress(serverId))

        // home goes away mid-browse: the next request fails over to the public address
        homeServer.stop(0)
        val http = client(router)
        assertEquals("public GET /Items", http.get("$public/Items"))
        assertEquals(public, router.activeAddress(serverId))

        // home is back on the same address: the next check moves back
        fake("home-back", port = homeServer.address.port)
        assertTrue(router.evaluate(serverId))
        assertEquals(home, router.activeAddress(serverId))
        assertEquals("home-back GET /Items", http.get("$public/Items"))
    }

    @Test
    fun refusesAnotherServer() {
        val (_, public) = fake("public")
        val (_, impostor) = fake("impostor", id = otherId)
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, impostor, home = true)
        assertTrue(router.evaluate(serverId))
        assertEquals(public, router.activeAddress(serverId))
        // forgotten: it is never tried again, not even when the server reports it as its LocalAddress
        assertFalse(impostor in router.candidates(serverId))
        assertFalse(router.learn(serverId, impostor, home = true))
        assertFalse(impostor in router.candidates(serverId))
    }

    @Test
    fun noSwitchToAnotherServerOnFailure() {
        val (publicServer, public) = fake("public")
        val (_, impostor) = fake("impostor", id = otherId)
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, impostor, home = true)
        publicServer.stop(0)
        val failed =
            try {
                client(router).get("$public/Items")
                false
            } catch (e: IOException) {
                true
            }
        assertTrue(failed)
        assertEquals(public, router.activeAddress(serverId))
        assertFalse(router.status.value[serverId]!!.reachable!!)
    }

    @Test
    fun learnsLocalAddressFromProbe() {
        val (_, home) = fake("home")
        val (_, public) = fake("public", localAddress = home)
        val router = router()
        router.register(serverId, public)
        assertTrue(router.evaluate(serverId))
        assertEquals(home, router.activeAddress(serverId))
    }

    @Test
    fun offlineWhenNothingAnswers() {
        val router = router()
        router.register(serverId, deadAddress())
        router.learn(serverId, deadAddress(), home = true)
        assertFalse(router.evaluate(serverId))
        assertEquals(false, router.status.value[serverId]!!.reachable)
    }

    @Test
    fun unknownServersPassThrough() {
        val (_, other) = fake("other")
        val router = router()
        assertEquals("other GET /x", client(router).get("$other/x"))
    }

    @Test
    fun keepsRoutesBetweenLaunches() {
        val (_, public) = fake("public")
        val (_, home) = fake("home")
        val store = MemoryRouteStore()
        router(store).apply {
            register(serverId, public)
            learn(serverId, home, home = true)
            evaluate(serverId)
        }
        assertEquals(
            StoredRoute(public, listOf(StoredAddress(public, false), StoredAddress(home, true)), home),
            store.routes[serverId],
        )
        val again = router(store)
        assertEquals(home, again.activeAddress(serverId))
        assertEquals("home GET /Items", client(again).get("$public/Items"))
    }

    @Test
    fun onlySafeRequestsAreRetried() {
        val get = Request.Builder().url("http://h/x").build()
        val post =
            Request
                .Builder()
                .url("http://h/x")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
        assertTrue(ServerRouter.retryable(get, IOException("reset")))
        assertFalse(ServerRouter.retryable(post, IOException("reset")))
        assertTrue(ServerRouter.retryable(post, ConnectException("refused")))
        assertTrue(ServerRouter.retryable(post, SocketTimeoutException("Connect timed out")))
        assertFalse(ServerRouter.retryable(post, SocketTimeoutException("timeout")))
    }

    @Test
    fun restartsPlaybackOnceAfterFailover() {
        val now = 1_000_000L
        // a 404 from the stream a minute after the switch: request it again
        assertTrue(RouteRecovery.shouldRestart(2004, now - 60_000, 0L, now))
        // not twice for the same switch, not without one, not long after, not for a decoder error
        assertFalse(RouteRecovery.shouldRestart(2004, now - 60_000, now - 60_000, now))
        assertFalse(RouteRecovery.shouldRestart(2004, 0L, 0L, now))
        assertFalse(RouteRecovery.shouldRestart(2001, now - RouteRecovery.WINDOW_MS - 1, 0L, now))
        assertFalse(RouteRecovery.shouldRestart(4003, now - 1_000, 0L, now))
    }

    @Test
    fun failoverIsMarked() {
        val (publicServer, public) = fake("public")
        val (_, home) = fake("home")
        val router = router()
        router.register(serverId, public)
        router.learn(serverId, deadAddress(), home = true)
        router.evaluate(serverId)
        assertEquals(0L, router.lastFailoverAt)
        router.learn(serverId, home, home = true)
        publicServer.stop(0)
        client(router).get("$public/Items")
        assertTrue(router.lastFailoverAt > 0L)
    }

    /** An address that accepts connections and never answers anything, not even `/System/Info/Public`. */
    private fun silentAddress(): String {
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        silent += socket
        thread(isDaemon = true) {
            val held = mutableListOf<Socket>()
            while (!socket.isClosed) {
                try {
                    held += socket.accept()
                } catch (e: IOException) {
                    break
                }
            }
            held.forEach { it.close() }
        }
        return "http://127.0.0.1:${socket.localPort}"
    }

    private val silent = mutableListOf<ServerSocket>()

    @After
    fun closeSilent() {
        silent.forEach { it.close() }
    }

    @Test
    fun silentAddressIsLeftWithinSeconds() {
        val saved = silentAddress()
        val (_, other) = fake("other")
        val sockets = RouteSockets()
        val router = ServerRouter(MemoryRouteStore(), homeHost = { false }, sockets = sockets)
        router.register(serverId, saved)
        router.learn(serverId, other, home = false)
        assertEquals(saved, router.activeAddress(serverId))
        // the SDK's timeouts: 30 s to read, 30 s for the whole call
        val client =
            OkHttpClient
                .Builder()
                .addInterceptor(router.interceptor)
                .socketFactory(sockets)
                .readTimeout(30, TimeUnit.SECONDS)
                .callTimeout(30, TimeUnit.SECONDS)
                .build()
        val started = System.nanoTime()
        assertEquals("other GET /Items", client.get("$saved/Items"))
        val tookMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("took $tookMs ms", tookMs < 8_000)
        assertEquals(other, router.activeAddress(serverId))
    }

    @Test
    fun slowServerKeepsItsAddress() {
        // answers its probe at once, but takes 4 s for the request itself (a transcode starting)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.executor =
            java.util.concurrent.Executors
                .newCachedThreadPool()
        server.createContext("/") { exchange ->
            val body =
                if (exchange.requestURI.path.endsWith("/System/Info/Public")) {
                    """{"Id":"$serverId"}"""
                } else {
                    Thread.sleep(4_000)
                    "slow ${exchange.requestURI.path}"
                }
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        servers += server
        val slow = "http://127.0.0.1:${server.address.port}"
        val (_, other) = fake("other")
        val sockets = RouteSockets()
        val router = ServerRouter(MemoryRouteStore(), homeHost = { false }, sockets = sockets)
        router.register(serverId, slow)
        router.learn(serverId, other, home = false)
        val client =
            OkHttpClient
                .Builder()
                .addInterceptor(router.interceptor)
                .socketFactory(sockets)
                .build()
        assertEquals("slow /Videos/1/hls1/main/0.ts", client.get("$slow/Videos/1/hls1/main/0.ts"))
        assertEquals(slow, router.activeAddress(serverId))
    }
}
