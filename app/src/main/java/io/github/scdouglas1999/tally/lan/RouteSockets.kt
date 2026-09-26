package io.github.scdouglas1999.tally.lan

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import timber.log.Timber
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.Collections
import java.util.WeakHashMap
import javax.net.SocketFactory

/**
 * The app's HTTP sockets, so the ones to an address that stopped answering can be closed ([closeTo]). A request
 * waiting on a server that accepted the connection and then went silent (a dead path that still accepts, a kept
 * connection whose route died) otherwise waits for the read timeout (30 seconds for API calls); closed, it fails at
 * once and the route's interceptor sends it to the address that answers. Set on the app's base OkHttp client (seam
 * W68), so the API, images, the players' OkHttp sources and multiview all use it.
 */
class RouteSockets : SocketFactory() {
    private val open: MutableSet<Socket> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    override fun createSocket(): Socket = TrackedSocket().also { open += it }

    override fun createSocket(
        host: String?,
        port: Int,
    ): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }

    override fun createSocket(
        host: String?,
        port: Int,
        localHost: InetAddress?,
        localPort: Int,
    ): Socket =
        createSocket().apply {
            bind(InetSocketAddress(localHost, localPort))
            connect(InetSocketAddress(host, port))
        }

    override fun createSocket(
        host: InetAddress?,
        port: Int,
    ): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }

    override fun createSocket(
        address: InetAddress?,
        port: Int,
        localAddress: InetAddress?,
        localPort: Int,
    ): Socket =
        createSocket().apply {
            bind(InetSocketAddress(localAddress, localPort))
            connect(InetSocketAddress(address, port))
        }

    /**
     * Closes every open socket to [base] (`scheme://host:port`): the requests waiting on them fail now. Blocking (it
     * may resolve the host name): call it off the main thread. Returns how many were closed.
     */
    fun closeTo(base: String): Int {
        val url = base.toHttpUrlOrNull() ?: return 0
        val addresses =
            try {
                InetAddress.getAllByName(url.host).toSet()
            } catch (e: IOException) {
                Timber.d(e, "Server route: cannot resolve %s", url.host)
                return 0
            }
        val matching =
            synchronized(open) {
                open.filter { socket ->
                    !socket.isClosed && socket.isConnected && socket.port == url.port && socket.inetAddress in addresses
                }
            }
        matching.forEach { socket ->
            try {
                socket.close()
            } catch (e: IOException) {
                Timber.d(e, "Server route: closing a socket failed")
            }
        }
        return matching.size
    }

    /** A plain socket that leaves the set once closed. */
    private inner class TrackedSocket : Socket() {
        override fun close() {
            open -= this
            super.close()
        }
    }
}
