package io.github.scdouglas1999.tally

import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.data.model.BaseItem
import com.github.damontecres.wholphin.preferences.AppPreference
import com.github.damontecres.wholphin.preferences.PlayerBackend
import com.github.damontecres.wholphin.ui.playback.CurrentPlayback
import io.github.scdouglas1999.tally.quality.QualityLadder
import io.github.scdouglas1999.tally.quality.QualityStatus
import io.github.scdouglas1999.tally.quality.maxBitratePreferenceIndex
import org.jellyfin.sdk.model.api.BaseItemDto
import org.jellyfin.sdk.model.api.BaseItemKind
import org.jellyfin.sdk.model.api.MediaProtocol
import org.jellyfin.sdk.model.api.MediaSourceInfo
import org.jellyfin.sdk.model.api.MediaSourceType
import org.jellyfin.sdk.model.api.MediaStream
import org.jellyfin.sdk.model.api.MediaStreamProtocol
import org.jellyfin.sdk.model.api.MediaStreamType
import org.jellyfin.sdk.model.api.PlayMethod
import org.jellyfin.sdk.model.api.TranscodeReason
import org.jellyfin.sdk.model.api.TranscodingInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class QualityLadderTest {
    private fun mbit(megabits: Int): Int = (megabits * AppPreference.MEGA_BIT).toInt()

    @Test
    fun `big buck bunny offers original with its bitrate then the rungs under 1080p and 14_8 mbps`() {
        val options = QualityLadder.options(1080, 14_772_533)
        assertEquals(
            listOf(
                "Original · 14.8 Mbps",
                "1080p · 10 Mbps",
                "1080p · 8 Mbps",
                "720p · 5 Mbps",
                "720p · 3 Mbps",
                "480p · 2 Mbps",
                "360p · 1 Mbps",
            ),
            options.map { it.label },
        )
        assertEquals(
            listOf(null, mbit(10), mbit(8), mbit(5), mbit(3), mbit(2), mbit(1)),
            options.map { it.bitsPerSecond },
        )
        assertEquals(listOf(null, 10, 8, 5, 3, 2, 1), options.map { it.megabits })
    }

    @Test
    fun `an unknown height or bitrate never drops a rung on that axis`() {
        val all = QualityLadder.options(null, null)
        assertEquals(14, all.size)
        assertEquals("Original", all.first().label)
        assertEquals("4K · 120 Mbps", all[1].label)
        assertEquals(
            listOf(
                "Original · 15 Mbps",
                "1080p · 10 Mbps",
                "1080p · 8 Mbps",
                "720p · 5 Mbps",
                "720p · 3 Mbps",
                "480p · 2 Mbps",
                "360p · 1 Mbps",
            ),
            QualityLadder.options(null, 15_000_000).map { it.label },
        )
        assertEquals(
            listOf("Original", "720p · 5 Mbps", "720p · 3 Mbps", "480p · 2 Mbps", "360p · 1 Mbps"),
            QualityLadder.options(720, null).map { it.label },
        )
    }

    @Test
    fun `a tiny 360p file only offers original`() {
        assertEquals(listOf("Original · 0.8 Mbps"), QualityLadder.options(360, 800_000).map { it.label })
    }

    @Test
    fun `original shows one decimal under 20 mbps and whole numbers from 20 up`() {
        assertEquals("Original", QualityLadder.originalLabel(null))
        assertEquals("Original · 14.8 Mbps", QualityLadder.originalLabel(14_772_533))
        assertEquals("Original · 19.9 Mbps", QualityLadder.originalLabel(19_900_000))
        assertEquals("Original · 20 Mbps", QualityLadder.originalLabel(20_000_000))
        assertEquals("Original · 81 Mbps", QualityLadder.originalLabel(80_600_000))
    }

    @Test
    fun `equal bitrate is not under the source and the same height at a lower bitrate is`() {
        assertFalse(QualityLadder.options(1080, mbit(10)).any { it.bitsPerSecond == mbit(10) })
        assertTrue(QualityLadder.options(1080, mbit(10) + 1).any { it.bitsPerSecond == mbit(10) })
        assertFalse(QualityLadder.options(1079, 50_000_000).any { it.label.startsWith("1080p") })
    }

    @Test
    fun `a 2160p 80 mbps source offers 4k 60 down to 360p 1`() {
        assertEquals(
            listOf(
                "Original · 80 Mbps",
                "4K · 60 Mbps",
                "4K · 40 Mbps",
                "1080p · 30 Mbps",
                "1080p · 20 Mbps",
                "1080p · 15 Mbps",
                "1080p · 10 Mbps",
                "1080p · 8 Mbps",
                "720p · 5 Mbps",
                "720p · 3 Mbps",
                "480p · 2 Mbps",
                "360p · 1 Mbps",
            ),
            QualityLadder.options(2160, 80_000_000).map { it.label },
        )
        // 80 decimal Mbps is under upstream's 80 Mbps step (80 x 1024 x 1024), above 4K 60.
        assertEquals(14, QualityLadder.options(2160, 130_000_000).size)
    }

    @Test
    fun `now line names the resolution and rounds bitrate to one decimal`() {
        assertEquals("1080p", QualityStatus.resolutionLabel(1080, 1920))
        assertEquals("4K", QualityStatus.resolutionLabel(2160, 3840))
        assertEquals("4K", QualityStatus.resolutionLabel(1600, 3840))
        assertEquals("720p", QualityStatus.resolutionLabel(720, 1280))
        assertEquals("480p", QualityStatus.resolutionLabel(480, 854))
        assertEquals("360p", QualityStatus.resolutionLabel(360, 640))
        assertEquals("14.8 Mbps", QualityStatus.bitrateLabel(14_772_533))
        assertEquals("4 Mbps", QualityStatus.bitrateLabel(4_000_000))
        assertNull(QualityStatus.bitrateLabel(0))
        assertEquals(
            "DIRECT PLAY · 1080p · 14.8 Mbps",
            QualityStatus.formatNowLine("DIRECT PLAY", "1080p", "14.8 Mbps"),
        )
        assertEquals(
            "TRANSCODING · 720p · 4 Mbps",
            QualityStatus.formatNowLine("TRANSCODING", "720p", "4 Mbps"),
        )
    }

    @Test
    fun `transcode now line uses transcode info and the ladder keeps the file height`() {
        val file =
            mediaSource(
                bitrate = 14_772_533,
                height = 1080,
                width = 1920,
            )
        val transcoded =
            mediaSource(
                bitrate = 4_000_000,
                height = 720,
                width = 1280,
            )
        val playback =
            CurrentPlayback(
                item =
                    BaseItem(
                        data =
                            BaseItemDto(
                                id = UUID.randomUUID(),
                                type = BaseItemKind.MOVIE,
                                height = 1080,
                                mediaSources = listOf(file),
                            ),
                    ),
                tracks = emptyList(),
                backend = PlayerBackend.EXO_PLAYER,
                playMethod = PlayMethod.TRANSCODE,
                playSessionId = "session",
                liveStreamId = null,
                mediaSourceInfo = transcoded,
                transcodeInfo =
                    TranscodingInfo(
                        audioCodec = "aac",
                        videoCodec = "h264",
                        container = "ts",
                        isVideoDirect = false,
                        isAudioDirect = false,
                        bitrate = 4_000_000,
                        framerate = null,
                        completionPercentage = null,
                        width = 1280,
                        height = 720,
                        audioChannels = 2,
                        hardwareAccelerationType = null,
                        transcodeReasons =
                            listOf(
                                TranscodeReason.AUDIO_CODEC_NOT_SUPPORTED,
                                TranscodeReason.CONTAINER_BITRATE_EXCEEDS_LIMIT,
                            ),
                    ),
            )
        assertEquals(1080, QualityStatus.sourceHeight(playback))
        assertEquals(14_772_533, QualityStatus.sourceBitrate(playback))
        val now = QualityStatus.now(playback)
        assertEquals(QualityStatus.Method.TRANSCODING, now?.method)
        assertEquals("720p", now?.resolution)
        assertEquals("4 Mbps", now?.bitrateLabel)
        assertEquals(
            listOf(
                TranscodeReason.AUDIO_CODEC_NOT_SUPPORTED,
                TranscodeReason.CONTAINER_BITRATE_EXCEEDS_LIMIT,
            ),
            now?.reasons,
        )
        assertEquals(
            listOf(
                "Original · 14.8 Mbps",
                "1080p · 10 Mbps",
                "1080p · 8 Mbps",
                "720p · 5 Mbps",
                "720p · 3 Mbps",
                "480p · 2 Mbps",
                "360p · 1 Mbps",
            ),
            QualityLadder.options(QualityStatus.sourceHeight(playback), QualityStatus.sourceBitrate(playback)).map { it.label },
        )
    }

    @Test
    fun `no playback yet is loading and direct play reads the file`() {
        assertNull(QualityStatus.now(null))
        val source = mediaSource(bitrate = 14_772_533, height = 1080, width = 1920)
        val playback =
            CurrentPlayback(
                item = BaseItem(data = BaseItemDto(id = UUID.randomUUID(), type = BaseItemKind.MOVIE)),
                tracks = emptyList(),
                backend = PlayerBackend.EXO_PLAYER,
                playMethod = PlayMethod.DIRECT_PLAY,
                playSessionId = null,
                liveStreamId = null,
                mediaSourceInfo = source,
            )
        val now = QualityStatus.now(playback)
        assertEquals(QualityStatus.Method.DIRECT_PLAY, now?.method)
        assertEquals("1080p", now?.resolution)
        assertEquals("14.8 Mbps", now?.bitrateLabel)
        assertTrue(now?.reasons.orEmpty().isEmpty())
    }

    @Test
    fun `a live stream's reported bitrate is ignored so the ladder follows its height`() {
        // Captured from the dev server's PlaybackInfo for a Tally channel: IsInfiniteStream, Bitrate 192018,
        // one 720p h264 video stream.
        val live = mediaSource(bitrate = 192_018, height = 720, width = 1280, infinite = true)
        val playback =
            CurrentPlayback(
                item = BaseItem(data = BaseItemDto(id = UUID.randomUUID(), type = BaseItemKind.TV_CHANNEL)),
                tracks = emptyList(),
                backend = PlayerBackend.EXO_PLAYER,
                playMethod = PlayMethod.TRANSCODE,
                playSessionId = "session",
                liveStreamId = "live",
                mediaSourceInfo = live,
            )
        assertNull(QualityStatus.sourceBitrate(playback))
        assertEquals(720, QualityStatus.sourceHeight(playback))
        assertEquals(
            listOf("Original", "720p · 5 Mbps", "720p · 3 Mbps", "480p · 2 Mbps", "360p · 1 Mbps"),
            QualityLadder.options(QualityStatus.sourceHeight(playback), QualityStatus.sourceBitrate(playback)).map { it.label },
        )
    }

    @Test
    fun `every transcode reason maps to a phrase and an unknown name becomes words`() {
        TranscodeReason.entries.forEach { reason ->
            assertTrue(reason.name, QualityStatus.reasonRes(reason) != null)
        }
        assertEquals(
            R.string.tally_quality_reason_audio_codec,
            QualityStatus.reasonRes(TranscodeReason.AUDIO_CODEC_NOT_SUPPORTED),
        )
        assertEquals(
            R.string.tally_quality_reason_quality_limit,
            QualityStatus.reasonRes(TranscodeReason.CONTAINER_BITRATE_EXCEEDS_LIMIT),
        )
        assertEquals(
            R.string.tally_quality_reason_video_codec,
            QualityStatus.reasonRes(TranscodeReason.VIDEO_CODEC_NOT_SUPPORTED),
        )
        assertEquals(
            R.string.tally_quality_reason_subtitles,
            QualityStatus.reasonRes(TranscodeReason.SUBTITLE_CODEC_NOT_SUPPORTED),
        )
        assertEquals("Something new", QualityStatus.enumWords("SOMETHING_NEW"))
    }

    @Test
    fun `every rung saved as the default lands exactly on its settings step`() {
        val preference = AppPreference.MaxBitrate
        assertEquals(preference.defaultValue, maxBitratePreferenceIndex(null))
        assertEquals("100 Mbps", preference.summarizer?.invoke(maxBitratePreferenceIndex(null)))
        val expected =
            mapOf(
                120 to 18L,
                80 to 15L,
                60 to 13L,
                40 to 11L,
                30 to 10L,
                20 to 9L,
                15 to 8L,
                10 to 7L,
                8 to 6L,
                5 to 5L,
                3 to 4L,
                2 to 3L,
                1 to 2L,
            )
        val rungs = QualityLadder.options(null, null).mapNotNull { it.megabits }
        assertEquals(expected.keys.toList(), rungs)
        expected.forEach { (megabits, index) ->
            assertEquals("$megabits Mbps", index, maxBitratePreferenceIndex(megabits))
            assertEquals("$megabits Mbps", preference.summarizer?.invoke(index))
        }
        // Safety net only: a value that is not a step lands on the nearest one, the lower on a tie.
        assertEquals("3 Mbps", preference.summarizer?.invoke(maxBitratePreferenceIndex(4)))
    }

    private fun mediaSource(
        bitrate: Int,
        height: Int,
        width: Int,
        infinite: Boolean = false,
    ): MediaSourceInfo =
        MediaSourceInfo(
            protocol = MediaProtocol.HTTP,
            type = MediaSourceType.DEFAULT,
            isRemote = false,
            readAtNativeFramerate = true,
            ignoreDts = true,
            ignoreIndex = true,
            genPtsInput = false,
            supportsTranscoding = true,
            supportsDirectStream = true,
            supportsDirectPlay = true,
            isInfiniteStream = infinite,
            requiresOpening = false,
            requiresClosing = false,
            requiresLooping = false,
            supportsProbing = true,
            transcodingSubProtocol = MediaStreamProtocol.HTTP,
            hasSegments = false,
            bitrate = bitrate,
            mediaStreams =
                listOf(
                    MediaStream(
                        type = MediaStreamType.VIDEO,
                        width = width,
                        height = height,
                        bitRate = bitrate,
                        index = 0,
                        isInterlaced = false,
                        isDefault = true,
                        isForced = false,
                        isHearingImpaired = false,
                        isExternal = false,
                        isTextSubtitleStream = false,
                        supportsExternalStream = false,
                    ),
                ),
        )

    @Test
    fun `every rung knows its height and other bitrates do not`() {
        val options = QualityLadder.options(2160, 200_000_000).drop(1)
        assertEquals(13, options.size)
        for (option in options) {
            val height = QualityLadder.heightFor(option.bitsPerSecond!!)
            val expected = if (option.label.startsWith("4K")) 2160 else option.label.substringBefore('p').toInt()
            assertEquals(option.label, expected, height)
        }
        assertNull(QualityLadder.heightFor(4_000_000))
    }

    @Test
    fun `a chosen rung sends its width with its height`() {
        assertEquals(854, QualityLadder.widthFor(480))
        assertEquals(1920, QualityLadder.widthFor(1080))
        io.github.scdouglas1999.tally.quality.TallyQuality
            .choose(mbit(2))
        try {
            val url =
                io.github.scdouglas1999.tally.quality.TallyQuality
                    .transcodingUrl("/videos/x/master.m3u8?VideoBitrate=2000000")
            assertTrue(url.contains("MaxHeight=480"))
            assertTrue(url.contains("MaxWidth=854"))
            assertTrue(url.contains("AllowVideoStreamCopy=false"))
            // a larger width from the device profile is lowered to the rung's, a smaller one is kept
            val profiled =
                io.github.scdouglas1999.tally.quality.TallyQuality
                    .transcodingUrl("/videos/x/master.m3u8?MaxWidth=1920&VideoBitrate=2000000")
            assertTrue(profiled.contains("?MaxWidth=854&"))
            assertFalse(profiled.contains("MaxWidth=1920"))
            val smaller =
                io.github.scdouglas1999.tally.quality.TallyQuality
                    .transcodingUrl("/videos/x/master.m3u8?maxWidth=640")
            assertTrue(smaller.contains("maxWidth=640"))
            assertFalse(smaller.contains("MaxWidth=854"))
        } finally {
            io.github.scdouglas1999.tally.quality.TallyQuality
                .choose(null)
        }
    }

    @Test
    fun `the device profile's frame rate cap goes when the source is not faster`() {
        val quality = io.github.scdouglas1999.tally.quality.TallyQuality
        val asked = "/videos/9a17/master.m3u8?VideoBitrate=5050880&MaxFramerate=60&MaxWidth=1280&MaxHeight=720"
        assertEquals(
            "/videos/9a17/master.m3u8?VideoBitrate=5050880&MaxWidth=1280&MaxHeight=720",
            quality.withoutRedundantMaxFramerate(asked, 60f),
        )
        assertEquals(
            "/videos/9a17/master.m3u8?VideoBitrate=5050880&MaxWidth=1280&MaxHeight=720",
            quality.withoutRedundantMaxFramerate(asked, 29.97f),
        )
        // 59.94 is 60
        assertEquals(false, quality.withoutRedundantMaxFramerate(asked, 59.94f).contains("MaxFramerate"))
        // a faster source keeps the cap, as does an unknown rate
        assertEquals(asked, quality.withoutRedundantMaxFramerate(asked, 120f))
        assertEquals(asked, quality.withoutRedundantMaxFramerate(asked, null))
        assertEquals("/x?MaxWidth=1", quality.withoutRedundantMaxFramerate("/x?MaxFramerate=60&MaxWidth=1", 30f))
        assertEquals("/x?MaxWidth=1", quality.withoutRedundantMaxFramerate("/x?MaxWidth=1&MaxFramerate=60", 30f))

        fun source(live: Boolean) =
            MediaSourceInfo(
                protocol = MediaProtocol.HTTP,
                type = MediaSourceType.DEFAULT,
                isRemote = false,
                readAtNativeFramerate = false,
                ignoreDts = true,
                ignoreIndex = false,
                genPtsInput = false,
                supportsTranscoding = true,
                supportsDirectStream = false,
                supportsDirectPlay = false,
                isInfiniteStream = live,
                requiresOpening = live,
                requiresClosing = live,
                requiresLooping = false,
                supportsProbing = true,
                transcodingSubProtocol = MediaStreamProtocol.HLS,
                hasSegments = false,
                liveStreamId = if (live) "e2329f49_af999c25_ae9f0714" else null,
                mediaStreams =
                    listOf(
                        MediaStream(
                            type = MediaStreamType.VIDEO,
                            index = -1,
                            width = 1920,
                            height = 1080,
                            realFrameRate = 60f,
                            isInterlaced = false,
                            isDefault = false,
                            isForced = false,
                            isHearingImpaired = false,
                            isExternal = false,
                            isTextSubtitleStream = false,
                            supportsExternalStream = false,
                        ),
                    ),
            )
        quality.choose(mbit(5))
        try {
            // the URL the app asked for on the dev server (an 8.4 Mbps 1080p60 channel, 720p · 5 Mbps)
            val sent = "/videos/9a17/master.m3u8?VideoBitrate=5050880&MaxFramerate=60&TranscodeReasons=DirectPlayError"
            val live = quality.transcodingUrl(sent, source(live = true))
            assertEquals(
                "/videos/9a17/master.m3u8?VideoBitrate=5050880&TranscodeReasons=DirectPlayError" +
                    "&AllowVideoStreamCopy=false&MaxHeight=720&MaxWidth=1280",
                live,
            )
            // without the source (a caller that has none) the URL keeps its cap
            assertTrue(quality.transcodingUrl(sent).contains("MaxFramerate=60"))
        } finally {
            quality.choose(null)
        }
    }
}
