@file:OptIn(UnstableApi::class)

package io.github.scdouglas1999.tally.downloads

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.text.format.Formatter
import androidx.annotation.OptIn
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.offline.DefaultDownloadIndex
import androidx.media3.exoplayer.offline.DefaultDownloaderFactory
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.Downloader
import androidx.media3.exoplayer.offline.DownloaderFactory
import androidx.media3.exoplayer.scheduler.Requirements
import androidx.room.Room
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.data.ServerRepository
import com.github.damontecres.wholphin.services.hilt.AuthOkHttpClient
import com.github.damontecres.wholphin.services.hilt.DefaultCoroutineScope
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.scdouglas1999.tally.downloads.db.DownloadRecord
import io.github.scdouglas1999.tally.downloads.db.OfflineProgress
import io.github.scdouglas1999.tally.downloads.db.TallyDownloadsDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.extensions.itemsApi
import org.jellyfin.sdk.api.client.extensions.playlistsApi
import org.jellyfin.sdk.api.client.extensions.tvShowsApi
import org.jellyfin.sdk.api.client.extensions.userApi
import org.jellyfin.sdk.api.client.extensions.userLibraryApi
import org.jellyfin.sdk.model.DeviceInfo
import org.jellyfin.sdk.model.api.BaseItemDto
import org.jellyfin.sdk.model.api.BaseItemKind
import org.jellyfin.sdk.model.api.ItemSortBy
import org.jellyfin.sdk.model.api.LocationType
import org.jellyfin.sdk.model.api.MediaSourceInfo
import org.jellyfin.sdk.model.api.MediaStreamType
import org.jellyfin.sdk.model.serializer.toUUIDOrNull
import timber.log.Timber
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/** Why a download stopped, and whether Tally tries again by itself. */
internal enum class DownloadFailure(
    val retry: Boolean,
) {
    SERVER_UNREACHABLE(true),
    SERVER_ERROR(true),
    REMOVED_ON_SERVER(false),
    NOT_ALLOWED(false),
    DISK_FULL(false),
    STORAGE_UNAVAILABLE(false),
    UNKNOWN(true),
    ;

    companion object {
        fun of(error: Throwable?): DownloadFailure {
            var cause = error
            while (cause != null) {
                when {
                    cause is HttpDataSource.InvalidResponseCodeException -> {
                        return when (cause.responseCode) {
                            404, 410 -> REMOVED_ON_SERVER
                            401, 403 -> NOT_ALLOWED
                            in 500..599 -> SERVER_ERROR
                            else -> UNKNOWN
                        }
                    }

                    cause.message?.contains("ENOSPC") == true || cause.message?.contains("No space left") == true -> {
                        return DISK_FULL
                    }

                    cause.message == STORAGE_UNAVAILABLE_MESSAGE -> {
                        return STORAGE_UNAVAILABLE
                    }

                    cause is UnknownHostException || cause is ConnectException ||
                        cause is SocketTimeoutException || cause is SocketException -> {
                        return SERVER_UNREACHABLE
                    }
                }
                cause = cause.cause
            }
            return if (error is HttpDataSource.HttpDataSourceException) SERVER_UNREACHABLE else UNKNOWN
        }

        /** Delay before automatic retry number [count] (1-based): 30 s, 1 min, 2 min... up to an hour. */
        fun retryDelayMs(count: Int): Long = (30_000L shl (count - 1).coerceIn(0, 7)).coerceAtMost(3_600_000L)
    }
}

internal const val STORAGE_UNAVAILABLE_MESSAGE = "Download storage not available"

/** Media3 stop reasons: paused by the user, or belongs to a user who is not signed in. */
internal const val STOP_PAUSED = 1
internal const val STOP_OTHER_USER = 2

/**
 * The machinery behind [TallyDownloads]: Media3's [DownloadManager] (one per process, main thread), the downloads
 * database, the per-item preparation (artwork, subtitles), failure handling with retries, and the lookups the player
 * uses to read downloads.
 */
@Singleton
class DownloadEngine
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
        private val api: ApiClient,
        private val serverRepository: ServerRepository,
        @param:AuthOkHttpClient authClient: OkHttpClient,
        private val deviceInfo: DeviceInfo,
        internal val storage: DownloadStorage,
        internal val settingsStore: DownloadSettingsStore,
        @param:DefaultCoroutineScope internal val scope: CoroutineScope,
    ) {
        internal val json = Json { ignoreUnknownKeys = true }

        internal val db: TallyDownloadsDatabase by lazy {
            Room.databaseBuilder(context, TallyDownloadsDatabase::class.java, TallyDownloadsDatabase.NAME).build()
        }
        internal val dao get() = db.downloads()

        private val downloadClient = authClient.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()
        private val networkFactory = TallyNetworkDataSource.Factory(OkHttpDataSource.Factory(downloadClient), ::baseUrlFor)
        private val assets = DownloadAssets(downloadClient)

        /** Every download record (all users), as stored. */
        internal val records: StateFlow<List<DownloadRecord>> by lazy {
            dao.observeAll().stateIn(scope, SharingStarted.Eagerly, emptyList())
        }

        internal val progressRows: StateFlow<List<OfflineProgress>> by lazy {
            dao.observeProgress().stateIn(scope, SharingStarted.Eagerly, emptyList())
        }

        private val downloadStates = MutableStateFlow<Map<String, Download>>(emptyMap())

        /** Media3's view of every download (completed ones included), by id. */
        internal val downloads: StateFlow<Map<String, Download>> = downloadStates.asStateFlow()

        private val notMetState = MutableStateFlow(0)

        /** Media3 requirements not met right now ([Requirements] flags). */
        internal val notMetRequirements: StateFlow<Int> = notMetState.asStateFlow()

        private var manager: DownloadManager? = null
        private val started = AtomicBoolean(false)
        private val preparing = Channel<String>(Channel.UNLIMITED)
        private val preparingJobs = mutableMapOf<String, Job>()

        /** The (server, user) whose downloads may run; null while nobody is signed in. */
        @Volatile private var gateOwner: Pair<String, String>? = null

        /** The Media3 manager; created on first use. Main thread only. */
        internal fun manager(): DownloadManager {
            manager?.let { return it }
            val settings = settingsStore.settings.value
            val created =
                DownloadManager(context, DefaultDownloadIndex(storage.databaseProvider), RoutingDownloaderFactory())
                    .apply {
                        maxParallelDownloads = settings.concurrentDownloads
                        minRetryCount = 3
                        requirements = requirementsFor(settings.wifiOnly)
                        // nothing runs until a user is signed in (their token authorizes the requests)
                        pauseDownloads()
                        addListener(listener)
                    }
            manager = created
            return created
        }

        private fun requirementsFor(wifiOnly: Boolean) =
            Requirements(if (wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)

        /** Starts everything once per process (idempotent): the manager, user gating, preparation, retries. */
        fun start() {
            if (!started.compareAndSet(false, true)) return
            scope.launch(Dispatchers.Main) {
                manager()
                records.value // subscribe
                progressRows.value
                launch { gateByUser() }
                launch { applySettings() }
                launch { pollProgress() }
                launch { prepareLoop() }
                launch { retryLoop() }
                launch(Dispatchers.IO) { reconcile() }
            }
        }

        private val listener =
            object : DownloadManager.Listener {
                override fun onInitialized(downloadManager: DownloadManager) {
                    notMetState.value = downloadManager.notMetRequirements
                    scope.launch(Dispatchers.IO) {
                        loadIndex()
                        applyGate(gateOwner)
                    }
                }

                override fun onDownloadChanged(
                    downloadManager: DownloadManager,
                    download: Download,
                    finalException: Exception?,
                ) {
                    downloadStates.value = downloadStates.value + (download.request.id to download)
                    when (download.state) {
                        Download.STATE_COMPLETED -> scope.launch { onCompleted(download) }
                        Download.STATE_FAILED -> scope.launch { onFailed(download, finalException) }
                        else -> Unit
                    }
                }

                override fun onDownloadRemoved(
                    downloadManager: DownloadManager,
                    download: Download,
                ) {
                    downloadStates.value = downloadStates.value - download.request.id
                }

                override fun onRequirementsStateChanged(
                    downloadManager: DownloadManager,
                    requirements: Requirements,
                    notMetRequirements: Int,
                ) {
                    notMetState.value = notMetRequirements
                    if (notMetRequirements == 0) scope.launch(Dispatchers.IO) { reconcile() }
                }
            }

        private suspend fun loadIndex() {
            val all = mutableMapOf<String, Download>()
            try {
                manager?.downloadIndex?.getDownloads()?.use { cursor ->
                    while (cursor.moveToNext()) all[cursor.download.request.id] = cursor.download
                }
            } catch (e: IOException) {
                Timber.w(e, "Could not read the download index")
            }
            withContext(Dispatchers.Main) {
                // live downloads carry fresher progress than the index
                manager?.currentDownloads?.forEach { all[it.request.id] = it }
                downloadStates.value = all
            }
        }

        /** Media3 reports progress only when asked: poll once a second while something downloads. */
        private suspend fun pollProgress() {
            while (true) {
                val manager = manager
                if (manager != null && manager.currentDownloads.any { it.state == Download.STATE_DOWNLOADING }) {
                    val current = manager.currentDownloads
                    downloadStates.value = downloadStates.value + current.associateBy { it.request.id }
                }
                delay(1_000)
            }
        }

        /**
         * Only the signed-in user's downloads run (the requests carry their token). With nobody signed in everything
         * waits; other users' downloads wait with [STOP_OTHER_USER] and keep a user's own pause.
         */
        private suspend fun gateByUser() {
            serverRepository.current
                .map { it?.let { current -> current.server.id.hex() to current.user.id.hex() } }
                .distinctUntilChanged()
                .collect { owner ->
                    gateOwner = owner
                    applyGate(owner)
                }
        }

        /** Before Media3 has read its index nothing is known, so nothing is resumed ([listener] applies it again). */
        private suspend fun applyGate(owner: Pair<String, String>?) {
            val all = dao.all().associateBy { it.id }
            withContext(Dispatchers.Main) {
                val manager = manager()
                if (owner == null || !manager.isInitialized) {
                    manager.pauseDownloads()
                    return@withContext
                }
                manager.currentDownloads.forEach { download ->
                    val id = download.request.id
                    val record = all[id]
                    val mine = record != null && record.serverId == owner.first && record.userId == owner.second
                    when {
                        mine && download.stopReason == STOP_OTHER_USER -> manager.setStopReason(id, 0)
                        !mine && download.stopReason == Download.STOP_REASON_NONE -> manager.setStopReason(id, STOP_OTHER_USER)
                    }
                }
                manager.resumeDownloads()
            }
        }

        private suspend fun applySettings() {
            settingsStore.settings.collect { settings ->
                withContext(Dispatchers.Main) {
                    val manager = manager()
                    manager.maxParallelDownloads = settings.concurrentDownloads
                    val requirements = requirementsFor(settings.wifiOnly)
                    if (manager.requirements != requirements) manager.requirements = requirements
                }
            }
        }

        /** The server's current URL for a download's server (only the signed-in server is known). */
        internal fun baseUrlFor(serverHex: String): String? {
            val current = serverRepository.current.value ?: return null
            if (current.server.id.hex() != serverHex) return null
            return api.baseUrl ?: current.server.url
        }

        // ------------------------------------------------------------------------------------------ enqueue

        /** The signed-in (server, user), or null. */
        internal fun owner(): Pair<UUID, UUID>? = serverRepository.current.value?.let { it.server.id to it.user.id }

        internal fun recordId(
            serverId: UUID,
            userId: UUID,
            itemId: UUID,
        ): String = "${serverId.hex()}_${userId.hex()}_${itemId.hex()}"

        /** A group's items with where they came from (playlist order), fetched in full from the server. */
        internal data class TargetItem(
            val item: BaseItemDto,
            val playlistId: UUID? = null,
            val playlistName: String? = null,
            val playlistIndex: Int? = null,
        )

        internal suspend fun resolveTarget(target: DownloadTarget): List<TargetItem> {
            val userId = owner()?.second
            val summaries: List<TargetItem> =
                when (target) {
                    is DownloadTarget.Items -> {
                        target.itemIds.map { TargetItem(fetchItem(it)) }
                    }

                    is DownloadTarget.Season -> {
                        episodes(target.seriesId, target.seasonId).map { TargetItem(it) }
                    }

                    is DownloadTarget.Series -> {
                        episodes(target.seriesId, null).map { TargetItem(it) }
                    }

                    is DownloadTarget.NextUnwatched -> {
                        val all = episodes(target.seriesId, null)
                        val refs =
                            all.map {
                                DownloadPlanner.EpisodeRef(
                                    id = it.id,
                                    season = it.parentIndexNumber,
                                    episode = it.indexNumber,
                                    played = it.userData?.played == true,
                                    playable = it.locationType != LocationType.VIRTUAL,
                                )
                            }
                        val chosen = DownloadPlanner.nextUnwatched(refs, target.count)
                        val byId = all.associateBy { it.id }
                        chosen.mapNotNull { byId[it] }.map { TargetItem(it) }
                    }

                    is DownloadTarget.Album -> {
                        api.itemsApi
                            .getItems(
                                userId = userId,
                                parentId = target.albumId,
                                includeItemTypes = listOf(BaseItemKind.AUDIO),
                                recursive = true,
                                sortBy = listOf(ItemSortBy.PARENT_INDEX_NUMBER, ItemSortBy.INDEX_NUMBER, ItemSortBy.SORT_NAME),
                            ).content.items
                            .map { TargetItem(it) }
                    }

                    is DownloadTarget.ArtistAlbums -> {
                        api.itemsApi
                            .getItems(
                                userId = userId,
                                albumArtistIds = listOf(target.artistId),
                                includeItemTypes = listOf(BaseItemKind.AUDIO),
                                recursive = true,
                                sortBy =
                                    listOf(
                                        ItemSortBy.ALBUM,
                                        ItemSortBy.PARENT_INDEX_NUMBER,
                                        ItemSortBy.INDEX_NUMBER,
                                        ItemSortBy.SORT_NAME,
                                    ),
                            ).content.items
                            .map { TargetItem(it) }
                    }

                    is DownloadTarget.Playlist -> {
                        val playlist = fetchItem(target.playlistId)
                        api.playlistsApi
                            .getPlaylistItems(playlistId = target.playlistId, userId = userId)
                            .content.items
                            .filter { it.type in DOWNLOADABLE_KINDS }
                            .mapIndexed { index, item -> TargetItem(item, playlist.id, playlist.name, index) }
                    }
                }
            // the full item (media sources, streams, chapters) as the player gets it
            return summaries
                .filter { it.item.type in DOWNLOADABLE_KINDS && it.item.locationType != LocationType.VIRTUAL }
                .map { it.copy(item = fetchItem(it.item.id)) }
        }

        private suspend fun fetchItem(itemId: UUID): BaseItemDto = api.userLibraryApi.getItem(itemId = itemId).content

        private suspend fun episodes(
            seriesId: UUID,
            seasonId: UUID?,
        ): List<BaseItemDto> =
            api.tvShowsApi
                .getEpisodes(seriesId = seriesId, userId = owner()?.second, seasonId = seasonId)
                .content.items

        internal fun planItem(item: BaseItemDto): PlanItem {
            val source = item.mediaSources?.firstOrNull()
            val video = source?.mediaStreams?.firstOrNull { it.type == MediaStreamType.VIDEO }
            return PlanItem(
                isVideo = item.type != BaseItemKind.AUDIO && video != null,
                sourceHeight = video?.height,
                sourceWidth = video?.width,
                sourceBitrate = source?.bitrate,
                sizeBytes = source?.size,
                runtimeTicks = item.runTimeTicks ?: source?.runTimeTicks,
                canDownload = item.canDownload,
            )
        }

        internal suspend fun permissions(): DownloadPermissions {
            val policy =
                try {
                    api.userApi
                        .getCurrentUser()
                        .content.policy
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Timber.w(e, "Could not refresh the user policy")
                    serverRepository.currentUserDto?.policy
                }
            return DownloadPermissions(
                download = policy?.enableContentDownloading == true,
                transcode = policy?.enableVideoPlaybackTranscoding == true,
            )
        }

        /** Adds records for [items] and queues their preparation. Returns (queued, already present). */
        internal suspend fun add(
            items: List<TargetItem>,
            requested: DownloadQuality,
        ): Pair<List<UUID>, List<UUID>> {
            val (serverId, userId) = owner() ?: return emptyList<UUID>() to emptyList()
            val settings = settingsStore.current()
            val location =
                if (settings.location == StorageLocation.REMOVABLE && storage.removableAvailable()) {
                    StorageLocation.REMOVABLE
                } else {
                    StorageLocation.INTERNAL
                }
            val queued = mutableListOf<UUID>()
            val present = mutableListOf<UUID>()
            for (target in items) {
                val item = target.item
                val id = recordId(serverId, userId, item.id)
                val existing = dao.get(id)
                if (existing != null && existing.failure == null) {
                    present += item.id
                    continue
                }
                if (existing != null) remove(existing)
                val quality = DownloadPlanner.qualityFor(planItem(item), requested)
                dao.put(newRecord(id, serverId, userId, target, quality, location))
                queued += item.id
                preparing.send(id)
            }
            return queued to present
        }

        private fun newRecord(
            id: String,
            serverId: UUID,
            userId: UUID,
            target: TargetItem,
            quality: DownloadQuality,
            location: StorageLocation,
        ): DownloadRecord {
            val item = target.item
            val source = item.mediaSources?.firstOrNull()
            val itemHex = item.id.hex()
            val converted = quality as? DownloadQuality.Converted
            val audioIndex =
                source?.defaultAudioStreamIndex
                    ?: source?.mediaStreams?.firstOrNull { it.type == MediaStreamType.AUDIO }?.index
            val pathAndQuery =
                if (converted == null) {
                    "/Items/$itemHex/Download"
                } else {
                    hlsPath(itemHex, source, converted.rung, audioIndex)
                }
            val plan = planItem(item)
            return DownloadRecord(
                id = id,
                serverId = serverId.hex(),
                userId = userId.hex(),
                itemId = itemHex,
                type = item.type.serialName,
                title = item.name.orEmpty(),
                seriesId = item.seriesId?.hex(),
                seriesName = item.seriesName,
                seasonId = item.seasonId?.hex(),
                seasonNumber = item.parentIndexNumber.takeIf { item.type == BaseItemKind.EPISODE },
                episodeNumber = item.indexNumber.takeIf { item.type == BaseItemKind.EPISODE },
                albumId = item.albumId?.hex(),
                album = item.album,
                albumArtist = item.albumArtist,
                artists = item.artists?.joinToString(DownloadRecord.ARTIST_SEPARATOR),
                playlistId = target.playlistId?.hex(),
                playlistName = target.playlistName,
                playlistIndex = target.playlistIndex,
                runtimeTicks = item.runTimeTicks,
                overview = item.overview,
                productionYear = item.productionYear,
                quality = if (converted == null) "ORIGINAL" else converted.rung.name,
                estimatedBytes = DownloadPlanner.estimate(listOf(plan), quality),
                location = location.name,
                mediaUri = TallyUri.build(serverId, location, userId, pathAndQuery),
                mimeType = if (converted == null) null else MimeTypes.APPLICATION_M3U8,
                sourceId = source?.id,
                audioStreamIndex = if (converted == null) null else audioIndex,
                itemJson = json.encodeToString(BaseItemDto.serializer(), item),
                sidecarsJson = "[]",
                posterPath = null,
                backdropPath = null,
                logoPath = null,
                thumbPath = null,
                assetsReady = false,
                failure = null,
                failureCount = 0,
                nextRetryAt = null,
                completedBytes = null,
                createdAt = System.currentTimeMillis(),
                completedAt = null,
                watchedAt = null,
            )
        }

        /**
         * Jellyfin's HLS transcode at a rung: H.264/AAC stereo, width and height capped (MaxHeight alone does not
         * lower the resolution on 10.10), one audio stream, no subtitles (they come as files), never a stream copy.
         * The play session id is fixed for the life of the download so a resumed download asks for the same URLs.
         */
        private fun hlsPath(
            itemHex: String,
            source: MediaSourceInfo?,
            rung: DownloadRung,
            audioIndex: Int?,
        ): String {
            val params =
                listOfNotNull(
                    source?.id?.let { "MediaSourceId=$it" },
                    "PlaySessionId=${UUID.randomUUID().hex()}",
                    "DeviceId=${Uri.encode(deviceInfo.id)}",
                    "VideoCodec=h264",
                    "AudioCodec=aac",
                    "VideoBitrate=${rung.videoBitsPerSecond}",
                    "AudioBitrate=${DownloadRung.AUDIO_BITS_PER_SECOND}",
                    "MaxWidth=${rung.width}",
                    "MaxHeight=${rung.height}",
                    audioIndex?.let { "AudioStreamIndex=$it" },
                    "TranscodingMaxAudioChannels=2",
                    "SegmentContainer=ts",
                    "MinSegments=1",
                    "BreakOnNonKeyFrames=False",
                    "AllowVideoStreamCopy=false",
                    "AllowAudioStreamCopy=false",
                    "EnableAdaptiveBitrateStreaming=false",
                )
            return "/Videos/$itemHex/master.m3u8?" + params.joinToString("&")
        }

        // ------------------------------------------------------------------------------------------ preparation

        /** Records whose media was never handed to Media3 (the app died while preparing) get prepared again. */
        private suspend fun reconcile() {
            dao.all().filter { !it.assetsReady && it.failure == null }.forEach { preparing.send(it.id) }
        }

        private suspend fun prepareLoop() {
            for (id in preparing) {
                val job = scope.launch(Dispatchers.IO) { prepare(id) }
                synchronized(preparingJobs) { preparingJobs[id] = job }
                job.join()
                synchronized(preparingJobs) { preparingJobs.remove(id) }
            }
        }

        /** Artwork and subtitles, then the media goes to Media3. */
        private suspend fun prepare(id: String) {
            val record = dao.get(id) ?: return
            if (record.assetsReady) return
            val base = baseUrlFor(record.serverId)
            if (base == null) {
                // not this user's turn; prepared again at the next start
                return
            }
            if (settingsStore.current().wifiOnly && isMetered()) {
                // artwork and subtitles wait for Wi-Fi like the media ([listener] prepares again when it changes)
                return
            }
            try {
                val item = json.decodeFromString(BaseItemDto.serializer(), record.itemJson)
                val dir = storage.assetsDir(id)
                val artwork = assets.fetchArtwork(base, item, dir)
                val source = item.mediaSources?.firstOrNull()
                val converted = record.quality != "ORIGINAL"
                val sidecars =
                    if (source != null && item.type != BaseItemKind.AUDIO) {
                        assets.fetchSidecars(base, item.id, source, converted, dir)
                    } else {
                        emptyList()
                    }
                val updated =
                    record.copy(
                        posterPath = artwork.poster,
                        backdropPath = artwork.backdrop,
                        logoPath = artwork.logo,
                        thumbPath = artwork.thumb,
                        sidecarsJson = json.encodeToString(sidecars),
                        assetsReady = true,
                    )
                // the record may have been deleted meanwhile
                if (dao.get(id) == null) return
                dao.put(updated)
                withContext(Dispatchers.Main) { manager().addDownload(request(updated)) }
                TallyDownloadService.start(context)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Timber.w(e, "Preparing download %s failed", id)
                recordFailure(record, DownloadFailure.of(e))
            }
        }

        internal fun request(record: DownloadRecord): DownloadRequest =
            DownloadRequest
                .Builder(record.id, Uri.parse(record.mediaUri))
                .setMimeType(record.mimeType)
                .setData(record.title.toByteArray())
                .build()

        // ------------------------------------------------------------------------------------------ outcomes

        private suspend fun onCompleted(download: Download) {
            val record = dao.get(download.request.id) ?: return
            if (record.completedAt != null) return
            dao.setCompleted(record.id, System.currentTimeMillis(), download.bytesDownloaded)
            seedProgress(record)
            DownloadNotifications.completed(context, record)
        }

        /** The server's progress as of the download, so the downloads page shows it before any sync. */
        private suspend fun seedProgress(record: DownloadRecord) {
            if (dao.progress(record.serverId, record.userId, record.itemId) != null) return
            val data =
                try {
                    json.decodeFromString(BaseItemDto.serializer(), record.itemJson).userData
                } catch (e: IllegalArgumentException) {
                    null
                } ?: return
            dao.putProgress(
                OfflineProgress(
                    serverId = record.serverId,
                    userId = record.userId,
                    itemId = record.itemId,
                    positionTicks = data.playbackPositionTicks,
                    played = data.played,
                    updatedAt = data.lastPlayedDate?.toEpochMs() ?: 0L,
                    pendingSync = false,
                ),
            )
        }

        private suspend fun onFailed(
            download: Download,
            error: Exception?,
        ) {
            val record = dao.get(download.request.id) ?: return
            val failure = DownloadFailure.of(error)
            Timber.w(error, "Download %s failed: %s", record.id, failure)
            recordFailure(record, failure)
        }

        private suspend fun recordFailure(
            record: DownloadRecord,
            failure: DownloadFailure,
        ) {
            val count = record.failureCount + 1
            val next = if (failure.retry) System.currentTimeMillis() + DownloadFailure.retryDelayMs(count) else null
            dao.setFailure(record.id, failure.name, count, next)
            if (!failure.retry) {
                DownloadNotifications.failed(context, record, failureText(failure))
            }
        }

        internal fun failureText(failure: DownloadFailure): String =
            context.getString(
                when (failure) {
                    DownloadFailure.SERVER_UNREACHABLE -> R.string.tally_dl_failed_unreachable
                    DownloadFailure.SERVER_ERROR -> R.string.tally_dl_failed_server
                    DownloadFailure.REMOVED_ON_SERVER -> R.string.tally_dl_failed_removed
                    DownloadFailure.NOT_ALLOWED -> R.string.tally_dl_failed_not_allowed
                    DownloadFailure.DISK_FULL -> R.string.tally_dl_failed_disk_full
                    DownloadFailure.STORAGE_UNAVAILABLE -> R.string.tally_dl_failed_storage
                    DownloadFailure.UNKNOWN -> R.string.tally_dl_failed_unknown
                },
            )

        /** Retries failed downloads whose backoff has passed (every 15 s), for the signed-in user only. */
        private suspend fun retryLoop() {
            while (true) {
                delay(15_000)
                retryDue(force = false)
            }
        }

        /** [force]: retry every retryable failure now (the server answered again). */
        internal suspend fun retryDue(force: Boolean) {
            val owner = owner() ?: return
            val now = System.currentTimeMillis()
            dao
                .all()
                .filter { it.serverId == owner.first.hex() && it.userId == owner.second.hex() }
                .filter { record ->
                    val failure = record.failure?.let { name -> DownloadFailure.entries.firstOrNull { it.name == name } }
                    failure != null && failure.retry && (force || (record.nextRetryAt ?: 0) <= now)
                }.forEach { retry(it) }
        }

        /** Tries a failed download again now. */
        internal suspend fun retry(record: DownloadRecord) {
            dao.setFailure(record.id, null, record.failureCount, null)
            if (!record.assetsReady) {
                preparing.send(record.id)
            } else {
                withContext(Dispatchers.Main) { manager().addDownload(request(record)) }
                TallyDownloadService.start(context)
            }
        }

        // ------------------------------------------------------------------------------------------ control

        internal suspend fun setPaused(
            record: DownloadRecord,
            paused: Boolean,
        ) {
            if (!paused && record.failure != null) {
                retry(record)
                return
            }
            withContext(Dispatchers.Main) {
                manager().setStopReason(record.id, if (paused) STOP_PAUSED else Download.STOP_REASON_NONE)
            }
            if (!paused) TallyDownloadService.start(context)
        }

        /** Removes a download: media, artwork, subtitles and the record (progress not yet reported is kept). */
        internal suspend fun remove(record: DownloadRecord) {
            synchronized(preparingJobs) { preparingJobs[record.id] }?.cancel()
            dao.delete(record.id)
            withContext(Dispatchers.Main) { manager().removeDownload(record.id) }
            withContext(Dispatchers.IO) { storage.deleteAssets(record.id) }
            dao.progress(record.serverId, record.userId, record.itemId)?.let {
                if (!it.pendingSync) dao.deleteProgress(it.serverId, it.userId, it.itemId)
            }
        }

        /** Whether the device has any validated network right now. */
        internal fun hasNetwork(): Boolean {
            val connectivity = context.getSystemService(ConnectivityManager::class.java) ?: return true
            val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
            return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        }

        /** The server answers again: its user details for the app (unknown after an offline start). */
        internal suspend fun refreshUser() {
            try {
                serverRepository.tallyRefreshUserDto()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Timber.w(e, "Could not refresh the user")
            }
        }

        /** The notification title of a download. */
        internal fun titleOf(id: String): String? = records.value.firstOrNull { it.id == id }?.displayTitle()

        private fun isMetered(): Boolean = context.getSystemService(ConnectivityManager::class.java)?.isActiveNetworkMetered ?: false

        internal fun formatBytes(bytes: Long): String = Formatter.formatShortFileSize(context, bytes)

        // ------------------------------------------------------------------------------------------ lookups

        /** A completed download of [itemId] for the signed-in user, read from the database. */
        internal suspend fun completedRecord(itemId: UUID): DownloadRecord? {
            val (serverId, userId) = owner() ?: return null
            return dao.get(recordId(serverId, userId, itemId))?.takeIf { isDone(it) }
        }

        /** A completed download of [itemId] for the signed-in user, from the in-memory list (any thread). */
        internal fun completed(itemId: UUID): DownloadRecord? {
            val (serverId, userId) = owner() ?: return null
            val id = recordId(serverId, userId, itemId)
            val record = records.value.firstOrNull { it.id == id } ?: return null
            return record.takeIf { isDone(it) }
        }

        /** Completed: Media3 has all of it and Tally recorded the completion. */
        internal fun isDone(record: DownloadRecord): Boolean {
            val download = downloadStates.value[record.id]
            return record.completedAt != null && (download == null || download.state == Download.STATE_COMPLETED)
        }

        internal fun sidecars(record: DownloadRecord): List<Sidecar> =
            try {
                json.decodeFromString(record.sidecarsJson)
            } catch (e: IllegalArgumentException) {
                Timber.w(e, "Bad sidecar list for %s", record.id)
                emptyList()
            }

        /** What the player's data source asks: the cache of a download, the file of a downloaded subtitle. */
        internal val lookup: DownloadLookup =
            object : DownloadLookup {
                override fun cacheSource(parts: TallyUri.Parts): DataSource? {
                    val cache: Cache = storage.cache(parts.location) ?: return null
                    return CacheDataSource
                        .Factory()
                        .setCache(cache)
                        .setUpstreamDataSourceFactory(networkFactory)
                        .setCacheWriteDataSinkFactory(null)
                        .createDataSource()
                }

                override fun sidecarFile(uri: Uri): File? {
                    val (itemHex, index) = subtitlePathKey(uri.encodedPath) ?: return null
                    val record = completed(itemHex.toUUIDOrNull() ?: return null) ?: return null
                    val sidecar = sidecars(record).firstOrNull { it.index == index } ?: return null
                    return File(sidecar.path).takeIf { it.exists() }
                }
            }

        /** Downloader factory with one cache per storage location (the location is part of the download's URI). */
        private inner class RoutingDownloaderFactory : DownloaderFactory {
            private val factories = mutableMapOf<StorageLocation, DownloaderFactory>()

            override fun createDownloader(request: DownloadRequest): Downloader {
                val location = TallyUri.parse(request.uri)?.location ?: StorageLocation.INTERNAL
                val factory =
                    synchronized(factories) {
                        factories[location] ?: storage.cache(location)?.let { cache ->
                            DefaultDownloaderFactory(
                                CacheDataSource
                                    .Factory()
                                    .setCache(cache)
                                    .setUpstreamDataSourceFactory(networkFactory),
                            ).also { factories[location] = it }
                        }
                    } ?: return UnavailableDownloader
                return factory.createDownloader(request)
            }
        }

        /** For a download whose storage (a removed card) is not there: fails, and removing it only drops the entry. */
        private object UnavailableDownloader : Downloader {
            override fun download(progressListener: Downloader.ProgressListener?): Unit = throw IOException(STORAGE_UNAVAILABLE_MESSAGE)

            override fun cancel() = Unit

            override fun remove() = Unit
        }

        internal companion object {
            val DOWNLOADABLE_KINDS =
                setOf(
                    BaseItemKind.MOVIE,
                    BaseItemKind.EPISODE,
                    BaseItemKind.VIDEO,
                    BaseItemKind.MUSIC_VIDEO,
                    BaseItemKind.AUDIO,
                )
        }
    }
