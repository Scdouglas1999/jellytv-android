package io.github.scdouglas1999.tally.lan

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionPool
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import timber.log.Timber
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** One known address of a server. [home]: reached over the home network (see [isHomeHost], LocalAddress, discovery). */
@Serializable
data class StoredAddress(
    val url: String,
    val home: Boolean,
)

/** What is kept per server: the address it was set up with, every address known for it, the last one that worked. */
@Serializable
data class StoredRoute(
    val saved: String,
    val addresses: List<StoredAddress>,
    val active: String? = null,
)

/** Where the routes are kept between launches (SharedPreferences in the app, memory in tests). */
interface RouteStore {
    fun load(): Map<String, StoredRoute>

    fun save(routes: Map<String, StoredRoute>)
}

class MemoryRouteStore : RouteStore {
    @Volatile
    var routes: Map<String, StoredRoute> = emptyMap()

    override fun load() = routes

    override fun save(routes: Map<String, StoredRoute>) {
        this.routes = routes
    }
}

/** The path a server is reached by right now, for Settings. [reachable] is null until the first check. */
data class RouteStatus(
    val active: String,
    val home: Boolean,
    val reachable: Boolean?,
)

/** The active address of [serverId] changed from [from] to [to]; [failure]: because [from] stopped answering. */
data class RouteSwitch(
    val serverId: String,
    val from: String,
    val to: String,
    val failure: Boolean,
)

/** The answer of an address to `/System/Info/Public`. */
sealed interface ProbeResult {
    /** The expected server answered; [localAddress] is the LocalAddress it reports. */
    data class Ok(
        val localAddress: String?,
    ) : ProbeResult

    /** Another server answered there: that address is never used for this server. */
    data class WrongServer(
        val id: String?,
    ) : ProbeResult

    data object Failed : ProbeResult
}

/**
 * Picks the address each request to a server goes to (the Tally part of the app's HTTP stack, see [TallyServerRoute]).
 *
 * Every server the app signed in to has a route: the address it was set up with ("saved", maybe the public address)
 * and the other addresses it is known by (its LocalAddress, what Jellyfin's discovery found on the network).
 * Requests are built with the saved address, as upstream builds them; [interceptor] moves each one to the route's
 * active address. Home addresses are preferred: when one answers, it is used, otherwise the saved one.
 * When the active address stops answering, the others are probed and the first that answers takes over (the request
 * is retried there); a periodic [evaluate] switches back when a preferred one answers again. An address only ever
 * becomes active after `/System/Info/Public` there answered with this server's id.
 */
class ServerRouter(
    private val store: RouteStore,
    private val probeClient: OkHttpClient = defaultProbeClient(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val homeHost: (String) -> Boolean = ::isHomeHost,
    /** The app's sockets: those to an address found dead are closed, so requests stuck on it move on. */
    private val sockets: RouteSockets? = null,
    /** How long a request may wait for its answer before the address it went to is checked. */
    private val hungAfterMs: Long = HUNG_AFTER_MS,
) {
    private class Address(
        val base: String,
        val url: HttpUrl,
        val home: Boolean,
    )

    private class Route(
        val serverId: String,
        @Volatile var saved: String,
        @Volatile var addresses: List<Address>,
        @Volatile var active: String,
    ) {
        @Volatile var reachable: Boolean? = null

        /** The address the websocket was last opened through. */
        @Volatile var socketBase: String? = null

        @Volatile var lastEmptyProbeAt = 0L

        /** The address being checked for a request that got no answer ([checkHung]), else null. */
        @Volatile var hungCheck: String? = null

        /** When an address last answered such a check: requests slow on a live server do not check it again at once. */
        @Volatile var aliveAt = 0L

        /** The address the route last left because it stopped answering (until the route goes back to it). */
        @Volatile var failedFrom: String? = null

        /** Addresses where another server answered: never learned again (until the app restarts). */
        val refused: MutableSet<String> = ConcurrentHashMap.newKeySet()
        val lock = Any()

        fun address(base: String) = addresses.firstOrNull { it.base == base }
    }

    private val routes = ConcurrentHashMap<String, Route>()

    private val _status = MutableStateFlow<Map<String, RouteStatus>>(emptyMap())

    /** The route of every known server, by normalized server id. */
    val status: StateFlow<Map<String, RouteStatus>> = _status.asStateFlow()

    private val _switches = MutableSharedFlow<RouteSwitch>(extraBufferCapacity = 16)
    val switches: SharedFlow<RouteSwitch> = _switches.asSharedFlow()

    init {
        try {
            store.load().forEach { (id, stored) ->
                val serverId = normalizeServerId(id) ?: return@forEach
                val saved = normalizeBase(stored.saved) ?: return@forEach
                val addresses =
                    stored.addresses.mapNotNull { address(it.url, it.home) }.let { list ->
                        if (list.none { it.base == saved }) list + address(saved, homeHost(saved.toHttpUrl().host))!! else list
                    }
                val active = stored.active?.let(::normalizeBase)?.takeIf { a -> addresses.any { it.base == a } } ?: saved
                routes[serverId] = Route(serverId, saved, addresses, active)
            }
        } catch (e: Exception) {
            Timber.w(e, "Server routes could not be read")
        }
        publish()
    }

    /**
     * The server [serverId] as the app saved it, at [savedUrl]. A new server starts on that address; a changed
     * address becomes the saved one and the old one stays known.
     */
    fun register(
        serverId: String,
        savedUrl: String,
    ) {
        val id = normalizeServerId(serverId) ?: return
        val saved = normalizeBase(savedUrl) ?: return
        val existing = routes[id]
        if (existing == null) {
            val address = address(saved, homeHost(saved.toHttpUrl().host)) ?: return
            routes[id] = Route(id, saved, listOf(address), saved)
            Timber.i("Server route for %s: saved address %s", id, saved)
        } else {
            synchronized(existing.lock) {
                if (existing.saved == saved) return
                existing.saved = saved
                if (existing.address(saved) == null) {
                    existing.addresses = existing.addresses + address(saved, homeHost(saved.toHttpUrl().host))!!
                }
            }
        }
        persist()
        publish()
    }

    /** [url] is another address of [serverId], on the home network when [home] (LocalAddress, discovery). */
    fun learn(
        serverId: String,
        url: String,
        home: Boolean,
    ): Boolean {
        val route = routes[normalizeServerId(serverId) ?: return false] ?: return false
        val base = normalizeBase(url) ?: return false
        synchronized(route.lock) {
            val known = route.address(base)
            if (known != null && (known.home || !home)) return false
            if (base in route.refused) return false
            val address = address(base, home || homeHost(base.toHttpUrl().host)) ?: return false
            route.addresses = route.addresses.filter { it.base != base } + address
            // the oldest addresses go first when there are too many; the saved one always stays
            while (route.addresses.size > MAX_ADDRESSES) {
                val drop = route.addresses.firstOrNull { it.base != route.saved && it.base != route.active } ?: break
                route.addresses = route.addresses - drop
            }
        }
        Timber.i("Server route for %s: learned %s (%s)", route.serverId, base, if (home) "home" else "other")
        persist()
        publish()
        return true
    }

    /** The addresses of [serverId] in the order they are tried: home addresses, then the saved one, then the rest. */
    fun candidates(serverId: String): List<String> = routes[normalizeServerId(serverId)]?.let { ordered(it) } ?: emptyList()

    fun activeAddress(serverId: String): String? = routes[normalizeServerId(serverId)]?.active

    /** True when [serverId] is on the address it prefers most (nothing better to switch back to). */
    fun onPreferred(serverId: String): Boolean {
        val route = routes[normalizeServerId(serverId)] ?: return true
        return ordered(route).firstOrNull() == route.active
    }

    /** The address the websocket of [serverId] was last opened through, or null. */
    fun socketAddress(serverId: String): String? = routes[normalizeServerId(serverId)]?.socketBase

    /** [url] moved to its server's active address (unchanged when no known server is at it). */
    fun resolve(url: HttpUrl): HttpUrl = target(url)?.url ?: url

    /** Where [url] goes now: its server, that server's active address and [url] moved there. Null: no known server. */
    fun target(url: HttpUrl): Target? {
        val (route, base) = match(url) ?: return null
        val active = route.active
        val activeUrl = route.address(active)?.url ?: return null
        return Target(route.serverId, active, rebase(url, base.url, activeUrl))
    }

    data class Target(
        val serverId: String,
        val active: String,
        val url: HttpUrl,
    )

    /**
     * Checks every address of [serverId] now and moves to the best one that answers. Returns true when one did
     * (false: neither the saved nor any other address answers, which is offline). Blocking: call it off the main
     * thread.
     */
    fun evaluate(serverId: String): Boolean {
        val route = routes[normalizeServerId(serverId) ?: return false] ?: return false
        synchronized(route.lock) {
            var results = probeAll(route, ordered(route))
            // an address the server reported that was not known yet: check it in the same pass
            val fresh = ordered(route).filter { it !in results }
            if (fresh.isNotEmpty()) results = results + probeAll(route, fresh)
            val best = ordered(route).firstOrNull { results[it] is ProbeResult.Ok }
            if (best != null) {
                if (best != route.active) switchTo(route, best, "check", failure = route.reachable == false)
                route.reachable = true
            } else {
                route.reachable = false
                Timber.i("Server route for %s: no address answers", route.serverId)
            }
        }
        publish()
        return route.reachable == true
    }

    /** The OkHttp interceptor that sends requests for a known server to its active address. */
    val interceptor: Interceptor = Interceptor { chain -> intercept(chain) }

    private fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val (route, base) = match(request.url) ?: return chain.proceed(request)
        val active = route.active
        val activeUrl = route.address(active)?.url ?: return chain.proceed(request)
        // a short connect timeout when another address could take over, so a dead path is left quickly
        val hasAlternative = route.addresses.size > 1
        val attemptChain =
            if (hasAlternative && chain.connectTimeoutMillis() > ALTERNATIVE_CONNECT_TIMEOUT_MS) {
                chain.withConnectTimeout(ALTERNATIVE_CONNECT_TIMEOUT_MS.toInt(), TimeUnit.MILLISECONDS)
            } else {
                chain
            }
        val first = request.newBuilder().url(rebase(request.url, base.url, activeUrl)).build()
        val failure: IOException
        // a request still waiting after a moment has its address checked: a path that accepts and never answers
        // is left within seconds, not after the read timeout
        val watchdog = if (hasAlternative) watch(route, active) else null
        try {
            val response =
                try {
                    attemptChain.proceed(first)
                } finally {
                    watchdog?.cancel(false)
                }
            if (!hasAlternative || !gatewayFailure(request, response)) {
                if (response.code == 101) route.socketBase = active
                return response
            }
            // a proxy on the way answered that it cannot reach the server: try another address before giving up
            val next = failover(route, active) ?: return response
            response.close()
            return proceedAt(chain, request, base, route, next)
        } catch (e: IOException) {
            failure = e
        }
        if (chain.call().isCanceled() || !hasAlternative || !retryable(request, failure)) throw failure
        val next = failover(route, active) ?: throw failure
        if (next == active) throw failure
        return try {
            proceedAt(chain, request, base, route, next)
        } catch (e: IOException) {
            e.addSuppressed(failure)
            throw e
        }
    }

    private fun proceedAt(
        chain: Interceptor.Chain,
        request: Request,
        base: Address,
        route: Route,
        next: String,
    ): Response {
        val nextUrl = route.address(next)?.url ?: throw IOException("Unknown address $next")
        val response = chain.proceed(request.newBuilder().url(rebase(request.url, base.url, nextUrl)).build())
        if (response.code == 101) route.socketBase = next
        return response
    }

    private val watchdogs: ScheduledThreadPoolExecutor by lazy {
        ScheduledThreadPoolExecutor(2) { runnable ->
            Thread(runnable, "tally-route-watchdog").apply { isDaemon = true }
        }.apply { removeOnCancelPolicy = true }
    }

    private fun watch(
        route: Route,
        address: String,
    ): ScheduledFuture<*>? =
        try {
            watchdogs.scheduleWithFixedDelay({ checkHung(route, address) }, hungAfterMs, HUNG_REPEAT_MS, TimeUnit.MILLISECONDS)
        } catch (e: RejectedExecutionException) {
            null
        }

    /**
     * A request to [address] got no answer for a while. The address is asked `/System/Info/Public` on a new
     * connection: when it answers, the server is only slow and the request keeps waiting. When it does not and another
     * address of the server answers, the route moves there and the sockets still open to [address] are closed: the
     * requests waiting on them fail now and are sent again to the new address ([intercept]). Repeated while the
     * request waits: once the route has left [address] as dead, connections opened to it since (OkHttp's own retry of
     * a closed connection) are closed too.
     */
    private fun checkHung(
        route: Route,
        address: String,
    ) {
        if (route.active != address) {
            if (route.failedFrom == address) sockets?.closeTo(address)
            return
        }
        synchronized(route.lock) {
            if (route.hungCheck != null || clock() - route.aliveAt < HUNG_RECHECK_MS) return
            route.hungCheck = address
        }
        try {
            if (probe(route.serverId, listOf(address))[address] is ProbeResult.Ok) {
                route.aliveAt = clock()
                return
            }
            Timber.i("Server route for %s: %s accepts requests but does not answer", route.serverId, address)
            val next = failover(route, address)
            if (next != null && next != address) {
                val closed = sockets?.closeTo(address) ?: 0
                Timber.i("Server route for %s: closed %d connection(s) to %s", route.serverId, closed, address)
            }
        } finally {
            route.hungCheck = null
        }
    }

    /**
     * [failed] did not answer a request: probe the other addresses and move to the first that answers. Returns the
     * address to use now, or null when none answers. Concurrent failures wait for one probe and share its answer.
     */
    fun failover(
        routeServerId: String,
        failed: String,
    ): String? = routes[normalizeServerId(routeServerId)]?.let { failover(it, failed) }

    private fun failover(
        route: Route,
        failed: String,
    ): String? {
        val found =
            synchronized(route.lock) {
                if (route.active != failed) return route.active
                // everything was down a moment ago: do not probe again for every request
                if (clock() - route.lastEmptyProbeAt < EMPTY_PROBE_COOLDOWN_MS) return null
                val others = ordered(route).filter { it != failed }
                val results = probeAll(route, others)
                val best = ordered(route).filter { it != failed }.firstOrNull { results[it] is ProbeResult.Ok }
                if (best != null) {
                    switchTo(route, best, "$failed stopped answering", failure = true)
                    route.reachable = true
                } else {
                    route.lastEmptyProbeAt = clock()
                    route.reachable = false
                    Timber.i("Server route for %s: %s stopped answering and no other address answers", route.serverId, failed)
                }
                best
            }
        publish()
        return found
    }

    private fun switchTo(
        route: Route,
        to: String,
        reason: String,
        failure: Boolean,
    ) {
        val from = route.active
        route.active = to
        route.lastEmptyProbeAt = 0L
        route.failedFrom = if (failure) from else route.failedFrom?.takeIf { it != to }
        if (failure) lastFailoverAt = clock()
        Timber.i("Server route for %s: %s -> %s (%s)", route.serverId, from, to, reason)
        persist()
        _switches.tryEmit(RouteSwitch(route.serverId, from, to, failure))
    }

    /** When the last switch away from an address that stopped answering happened (0: never). */
    @Volatile
    var lastFailoverAt = 0L
        private set

    /** Probes [bases] in parallel; learns the LocalAddress they report and forgets addresses of another server. */
    private fun probeAll(
        route: Route,
        bases: List<String>,
    ): Map<String, ProbeResult> {
        if (bases.isEmpty()) return emptyMap()
        val results = probe(route.serverId, bases)
        results.forEach { (base, result) ->
            when (result) {
                is ProbeResult.WrongServer -> {
                    Timber.w(
                        "Server route for %s: %s is another server (%s), refused",
                        route.serverId,
                        base,
                        result.id,
                    )
                    route.refused += base
                    if (base != route.saved && base != route.active) {
                        route.addresses = route.addresses.filter { it.base != base }
                        persist()
                    }
                }

                is ProbeResult.Ok -> {
                    result.localAddress?.let { local ->
                        val localBase = normalizeBase(local)
                        if (localBase != null && localBase !in route.refused && route.address(localBase)?.home != true) {
                            val address = address(localBase, true)
                            if (address != null) {
                                route.addresses = route.addresses.filter { it.base != localBase } + address
                                Timber.i("Server route for %s: learned LocalAddress %s", route.serverId, localBase)
                                persist()
                            }
                        }
                    }
                }

                ProbeResult.Failed -> {}
            }
        }
        return results
    }

    /** Asks each of [bases] for `/System/Info/Public` at once and waits for all (or the probe timeout). */
    fun probe(
        serverId: String,
        bases: List<String>,
    ): Map<String, ProbeResult> {
        val expected = normalizeServerId(serverId)
        val results = ConcurrentHashMap<String, ProbeResult>()
        val latch = CountDownLatch(bases.size)
        val calls =
            bases.map { base ->
                val call =
                    probeClient.newCall(
                        Request
                            .Builder()
                            .url(base.trimEnd('/') + "/System/Info/Public")
                            .header("Accept", "application/json")
                            .build(),
                    )
                call.enqueue(
                    object : Callback {
                        override fun onFailure(
                            call: Call,
                            e: IOException,
                        ) {
                            Timber.d("Server route probe %s failed: %s", base, e.toString())
                            results[base] = ProbeResult.Failed
                            latch.countDown()
                        }

                        override fun onResponse(
                            call: Call,
                            response: Response,
                        ) {
                            results[base] =
                                try {
                                    response.use { parseProbe(it, expected) }
                                } catch (e: Exception) {
                                    ProbeResult.Failed
                                }
                            latch.countDown()
                        }
                    },
                )
                call
            }
        if (!latch.await(PROBE_TIMEOUT_MS + 1_000, TimeUnit.MILLISECONDS)) calls.forEach { it.cancel() }
        return bases.associateWith { results[it] ?: ProbeResult.Failed }
    }

    private fun parseProbe(
        response: Response,
        expected: String?,
    ): ProbeResult {
        if (!response.isSuccessful) return ProbeResult.Failed
        val json = Json.parseToJsonElement(response.body.string()).jsonObject
        val id = json["Id"]?.jsonPrimitive?.content
        if (normalizeServerId(id) != expected) return ProbeResult.WrongServer(id)
        return ProbeResult.Ok(json["LocalAddress"]?.jsonPrimitive?.content)
    }

    private fun ordered(route: Route): List<String> =
        route.addresses
            .sortedBy {
                when {
                    it.home -> 0
                    it.base == route.saved -> 1
                    else -> 2
                }
            }.map { it.base }

    /** The route and address [url] is under (the longest matching address when several match). */
    private fun match(url: HttpUrl): Pair<Route, Address>? {
        var found: Pair<Route, Address>? = null
        for (route in routes.values) {
            for (address in route.addresses) {
                if (!isUnder(url, address.url)) continue
                if (found == null || address.url.encodedPath.length > found.second.url.encodedPath.length) {
                    found = route to address
                }
            }
        }
        return found
    }

    private fun persist() {
        try {
            store.save(
                routes.mapValues { (_, route) ->
                    StoredRoute(
                        saved = route.saved,
                        addresses = route.addresses.map { StoredAddress(it.base, it.home) },
                        active = route.active,
                    )
                },
            )
        } catch (e: Exception) {
            Timber.w(e, "Server routes could not be saved")
        }
    }

    private fun publish() {
        _status.update {
            routes.mapValues { (_, route) ->
                RouteStatus(
                    active = route.active,
                    home = route.address(route.active)?.home ?: false,
                    reachable = route.reachable,
                )
            }
        }
    }

    companion object {
        const val PROBE_TIMEOUT_MS = 2_500L
        const val ALTERNATIVE_CONNECT_TIMEOUT_MS = 4_000L
        const val EMPTY_PROBE_COOLDOWN_MS = 3_000L

        /** A request with no answer after this long has its address checked (a live server answers a probe at once). */
        const val HUNG_AFTER_MS = 2_000L

        /** An address that answered a check is not checked again for this long. */
        const val HUNG_RECHECK_MS = 5_000L

        /** How often a request that is still waiting has its address checked again. */
        const val HUNG_REPEAT_MS = 1_000L
        const val MAX_ADDRESSES = 8

        fun defaultProbeClient(): OkHttpClient =
            OkHttpClient
                .Builder()
                .connectTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .callTimeout(PROBE_TIMEOUT_MS + 500, TimeUnit.MILLISECONDS)
                // a fresh connection for every probe: a kept one may lead to a server that is gone
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
                .build()

        private fun address(
            base: String,
            home: Boolean,
        ): Address? {
            val normalized = normalizeBase(base) ?: return null
            return Address(normalized, normalized.toHttpUrl(), home)
        }

        /** Whether a failed request may be sent again to another address. */
        internal fun retryable(
            request: Request,
            e: IOException,
        ): Boolean {
            if (request.body?.isOneShot() == true) return false
            if (request.method == "GET" || request.method == "HEAD") return true
            // anything else only when it never reached the server
            return e is ConnectException || e is NoRouteToHostException || e is UnknownHostException ||
                (e is SocketTimeoutException && e.message?.contains("connect", ignoreCase = true) == true)
        }

        /** A gateway on the way (a reverse proxy, the router) answered that the server is not reachable. */
        private fun gatewayFailure(
            request: Request,
            response: Response,
        ): Boolean = (response.code == 502 || response.code == 504) && (request.method == "GET" || request.method == "HEAD")
    }
}
