package io.github.scdouglas1999.tally.ui.player.controls.phone

import android.os.SystemClock
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.Player
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.data.model.BaseItem
import com.github.damontecres.wholphin.data.model.Chapter
import com.github.damontecres.wholphin.ui.AppColors
import com.github.damontecres.wholphin.ui.FontAwesome
import com.github.damontecres.wholphin.ui.playback.AnalyticsState
import com.github.damontecres.wholphin.ui.playback.ControllerViewState
import com.github.damontecres.wholphin.ui.playback.CurrentPlayback
import com.github.damontecres.wholphin.ui.playback.PlaybackDialogType
import com.github.damontecres.wholphin.ui.playback.overlay.PlaybackAction
import com.github.damontecres.wholphin.ui.playback.overlay.PlaybackDebugOverlay
import com.github.damontecres.wholphin.ui.seekBack
import com.github.damontecres.wholphin.ui.seekForward
import com.github.damontecres.wholphin.ui.skipStringRes
import io.github.scdouglas1999.tally.media.series.episodeCode
import io.github.scdouglas1999.tally.ui.components.tallyUppercase
import io.github.scdouglas1999.tally.ui.phone.PhoneTopBarAction
import io.github.scdouglas1999.tally.ui.phone.phoneClickable
import io.github.scdouglas1999.tally.ui.player.controls.PlayerFormat
import io.github.scdouglas1999.tally.ui.player.controls.PreviewAbove
import io.github.scdouglas1999.tally.ui.player.controls.TallyLiveBar
import io.github.scdouglas1999.tally.ui.player.controls.TallyTrickplayPreview
import io.github.scdouglas1999.tally.ui.player.controls.TrackCanvas
import io.github.scdouglas1999.tally.ui.player.controls.rememberPlayerProgress
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import io.github.scdouglas1999.tally.ui.theme.PhoneType
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.jellyfin.sdk.model.api.MediaSegmentDto
import org.jellyfin.sdk.model.api.TrickplayInfo
import org.jellyfin.sdk.model.extensions.ticks
import kotlin.time.Duration

/** The controls hide after this long without a touch (they stay while paused). */
internal const val PHONE_CONTROLS_MS = 4_000L

/** Two taps on the same side within this long are a double tap. */
private const val DOUBLE_TAP_MS = 300L

/** After a double-tap seek, further taps on that side within this long add up. */
private const val SEEK_CHAIN_MS = 700L

/** Show / hide of the controls. */
private const val FADE_MS = 150

/**
 * The player controls on a phone (landscape), drawn in place of the TV's by [io.github.scdouglas1999.tally.ui.player
 * .controls.TallyPlaybackOverlay] (same parameters, same upstream state and actions). A tap shows or hides them; they
 * hide after [PHONE_CONTROLS_MS] and stay while paused. Top: back, the title (and `S1 E6 · The Weekend` for an
 * episode), subtitles and settings. Center: back by the skip length, play/pause, forward (previous / next when the TV
 * row has them). Bottom: the seek bar with the times at both ends, draggable, with the trickplay thumbnail over the
 * finger (live: the TV's live bar, no seek). A double tap on the left or right third jumps back or forward, and
 * further taps there add up.
 */
@Composable
fun PhonePlaybackOverlay(
    item: BaseItem?,
    chapters: List<Chapter>,
    player: Player,
    controllerViewState: ControllerViewState,
    showPlay: Boolean,
    previousEnabled: Boolean,
    nextEnabled: Boolean,
    seekEnabled: Boolean,
    seekBack: Duration,
    skipBackOnResume: Duration?,
    seekForward: Duration,
    onPlaybackActionClick: (PlaybackAction) -> Unit,
    onClickPlaybackDialogType: (PlaybackDialogType) -> Unit,
    showDebugInfo: Boolean,
    currentPlayback: CurrentPlayback?,
    currentSegment: MediaSegmentDto?,
    analyticsState: AnalyticsState,
    trickplayInfo: TrickplayInfo?,
    trickplayUrlFor: (Int) -> String?,
    modifier: Modifier = Modifier,
) {
    val kind = PlayerFormat.kind(item?.data)
    var live by remember(player) { mutableStateOf(player.isCurrentMediaItemLive) }
    LaunchedEffect(player) {
        while (isActive) {
            live = player.isCurrentMediaItemLive
            delay(1000L)
        }
    }
    val isLive = live || kind == PlayerFormat.Kind.LIVE
    val visible = controllerViewState.controlsVisible

    // Visible and playing: hide after the phone's delay. Visible and paused: stay.
    LaunchedEffect(visible, showPlay) {
        if (visible) controllerViewState.pulseControls(if (showPlay) Long.MAX_VALUE else PHONE_CONTROLS_MS)
    }
    val keepAlive = { controllerViewState.pulseControls(if (showPlay) Long.MAX_VALUE else PHONE_CONTROLS_MS) }

    val seekTaps = rememberSeekTaps(player, seekBack, seekForward, controllerViewState, isLive)

    Box(modifier = modifier.fillMaxSize()) {
        // The tap layer under everything: show / hide, double taps on the sides.
        var size by remember { mutableStateOf(IntSize.Zero) }
        Box(
            Modifier
                .fillMaxSize()
                .onSizeChanged { size = it }
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { offset -> seekTaps.onTap(offset.x, size.width.toFloat()) })
                },
        )

        AnimatedVisibility(
            visible = visible,
            enter = fadeIn(tween(FADE_MS)),
            exit = fadeOut(tween(FADE_MS)),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(Modifier.fillMaxSize()) {
                // Image scrims: the controls stay legible on any picture.
                Box(
                    Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .height(120.dp)
                        .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.7f), Color.Transparent))),
                )
                Box(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(150.dp)
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f)))),
                )
                Box(
                    Modifier
                        .fillMaxSize()
                        .windowInsetsPadding(WindowInsets.displayCutout),
                ) {
                    TopRow(
                        item = item,
                        isLive = isLive,
                        onSubtitles = {
                            keepAlive()
                            onClickPlaybackDialogType(PlaybackDialogType.CAPTIONS)
                        },
                        onSettings = {
                            keepAlive()
                            onClickPlaybackDialogType(PlaybackDialogType.SETTINGS)
                        },
                        modifier = Modifier.align(Alignment.TopCenter),
                    )
                    Transport(
                        player = player,
                        showPlay = showPlay,
                        isLive = isLive,
                        previousEnabled = previousEnabled,
                        nextEnabled = nextEnabled,
                        seekBack = seekBack,
                        seekForward = seekForward,
                        skipBackOnResume = skipBackOnResume,
                        onInteraction = keepAlive,
                        onPlaybackActionClick = onPlaybackActionClick,
                        modifier = Modifier.align(Alignment.Center),
                    )
                    Column(
                        modifier =
                            Modifier
                                .align(Alignment.BottomCenter)
                                .fillMaxWidth()
                                .padding(horizontal = PhoneDimens.margin)
                                .padding(bottom = 12.dp),
                    ) {
                        if (currentSegment != null) {
                            PhoneSkipButton(
                                label = stringResource(currentSegment.type.skipStringRes),
                                onClick = {
                                    keepAlive()
                                    player.seekTo(currentSegment.endTicks.ticks.inWholeMilliseconds)
                                },
                                modifier = Modifier.align(Alignment.End).padding(bottom = 8.dp),
                            )
                        }
                        if (isLive) {
                            TallyLiveBar(name = item?.name, modifier = Modifier.height(PhoneDimens.touchTarget))
                        } else {
                            PhoneSeekBar(
                                player = player,
                                chapters = chapters,
                                enabled = seekEnabled,
                                controllerViewState = controllerViewState,
                                showPlay = showPlay,
                                trickplayInfo = trickplayInfo,
                                trickplayUrlFor = trickplayUrlFor,
                            )
                        }
                    }
                }
            }
        }

        // The running double-tap seek, on its side.
        seekTaps.indicator?.let { shown ->
            Box(
                contentAlignment = Alignment.Center,
                modifier =
                    Modifier
                        .align(if (shown < 0) Alignment.CenterStart else Alignment.CenterEnd)
                        .fillMaxHeight()
                        .fillMaxWidth(1f / 3f),
            ) {
                Text(
                    text = PhoneSeekLabel.format(shown),
                    style = PhoneType.labelLarge.copy(fontSize = 18.sp),
                    color = TallyColors.text,
                    maxLines = 1,
                    modifier =
                        Modifier
                            .background(Color.Black.copy(alpha = 0.6f))
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                )
            }
        }

        // Upstream's debug overlay, as the TV draws it.
        if (showDebugInfo && visible) {
            val configuration = LocalConfiguration.current
            PlaybackDebugOverlay(
                analyticsState = analyticsState,
                currentPlayback = currentPlayback,
                modifier =
                    Modifier
                        .align(Alignment.TopStart)
                        .heightIn(max = (configuration.screenHeightDp * 0.6f).dp)
                        .padding(start = PhoneDimens.margin, top = 64.dp)
                        .background(AppColors.TransparentBlack50)
                        .padding(8.dp),
            )
        }
    }
}

/** `−10s` / `+30s`: the running double-tap seek in seconds (a real minus sign). */
internal object PhoneSeekLabel {
    fun format(ms: Long): String {
        val seconds = kotlin.math.abs(ms) / 1000L
        return if (ms < 0) "−${seconds}s" else "+${seconds}s"
    }
}

/**
 * Tap handling of the picture: a single tap shows or hides the controls; two taps on the left or right third within
 * [DOUBLE_TAP_MS] jump back or forward by the skip length, and every further tap on that side within [SEEK_CHAIN_MS]
 * adds another jump. A tap on a side waits [DOUBLE_TAP_MS] before it toggles the controls (a second tap cancels it).
 */
private class SeekTaps(
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val playerNow: () -> Player,
    private val seekBack: () -> Duration,
    private val seekForward: () -> Duration,
    private val controller: ControllerViewState,
    private val isLive: () -> Boolean,
) {
    var indicator by mutableStateOf<Long?>(null)
        private set
    private var lastTapAt = 0L
    private var lastSide = 0
    private var chainUntil = 0L
    private var chainSide = 0
    private var pendingToggle: Job? = null
    private var clearIndicator: Job? = null

    fun onTap(
        x: Float,
        width: Float,
    ) {
        val now = SystemClock.uptimeMillis()
        // A live channel cannot be skipped through (as on the TV): every tap only shows or hides the controls.
        val side =
            when {
                isLive() -> 0
                width <= 0f -> 0
                x < width / 3f -> -1
                x > width * 2f / 3f -> 1
                else -> 0
            }
        if (side != 0 && ((side == chainSide && now < chainUntil) || (side == lastSide && now - lastTapAt < DOUBLE_TAP_MS))) {
            pendingToggle?.cancel()
            pendingToggle = null
            seek(side, now)
            lastTapAt = 0L
            return
        }
        lastTapAt = now
        lastSide = side
        pendingToggle?.cancel()
        if (side == 0) {
            toggle()
        } else {
            pendingToggle =
                scope.launch {
                    delay(DOUBLE_TAP_MS)
                    toggle()
                }
        }
    }

    private fun toggle() {
        if (controller.controlsVisible) controller.hideControls() else controller.showControls(PHONE_CONTROLS_MS)
    }

    private fun seek(
        side: Int,
        now: Long,
    ) {
        val player = playerNow()
        val step = if (side < 0) -seekBack().inWholeMilliseconds else seekForward().inWholeMilliseconds
        if (side < 0) player.seekBack(seekBack()) else player.seekForward(seekForward())
        val running = indicator
        indicator = if (running != null && running.sign() == side && chainSide == side) running + step else step
        chainSide = side
        chainUntil = now + SEEK_CHAIN_MS
        if (controller.controlsVisible) controller.pulseControls(PHONE_CONTROLS_MS)
        clearIndicator?.cancel()
        clearIndicator =
            scope.launch {
                delay(SEEK_CHAIN_MS)
                indicator = null
                chainSide = 0
            }
    }

    private fun Long.sign(): Int = if (this < 0) -1 else 1
}

@Composable
private fun rememberSeekTaps(
    player: Player,
    seekBack: Duration,
    seekForward: Duration,
    controller: ControllerViewState,
    isLive: Boolean,
): SeekTaps {
    val scope = rememberCoroutineScope()
    val playerNow by rememberUpdatedState(player)
    val live by rememberUpdatedState(isLive)
    val back by rememberUpdatedState(seekBack)
    val forward by rememberUpdatedState(seekForward)
    return remember(controller) { SeekTaps(scope, { playerNow }, { back }, { forward }, controller, { live }) }
}

/** Back, the title block, the live player's buttons (a live channel only), subtitles and settings. */
@Composable
private fun TopRow(
    item: BaseItem?,
    isLive: Boolean,
    onSubtitles: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val dto = item?.data
    val backDispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val episode = PlayerFormat.kind(dto) == PlayerFormat.Kind.EPISODE
    val title =
        if (episode) {
            dto?.seriesName?.takeIf { it.isNotBlank() } ?: PlayerFormat.title(dto)
        } else {
            PlayerFormat.title(dto)
        }
    val sub =
        when {
            isLive -> {
                stringResource(R.string.tally_player_kicker_live).tallyUppercase()
            }

            episode -> {
                listOfNotNull(
                    episodeCode(dto?.parentIndexNumber, dto?.indexNumber, dto?.indexNumberEnd),
                    dto?.name?.takeIf { it.isNotBlank() },
                ).joinToString(" · ").ifBlank { null }
            }

            else -> {
                PlayerFormat.meta(dto)
            }
        }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        // under the status strip: every button is a full 48dp target a tap reaches
        modifier = modifier.fillMaxWidth().playerTopBarInset().padding(horizontal = 8.dp, vertical = 8.dp),
    ) {
        PhoneTopBarAction(
            glyph = R.string.tally_phone_fa_arrow_left,
            label = stringResource(R.string.tally_phone_back),
            onClick = { backDispatcher?.onBackPressed() },
        )
        Spacer(Modifier.width(4.dp))
        Column(modifier = Modifier.weight(1f)) {
            if (title != null) {
                Text(
                    text = title,
                    style = PhoneType.headline,
                    color = TallyColors.text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (sub != null) {
                Text(
                    text = sub,
                    style = PhoneType.meta,
                    color = if (isLive) TallyColors.liveText else TallyColors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The live player's GAMES and BOX SCORE (nothing outside a live channel).
        io.github.scdouglas1999.tally.ui.player.phone
            .LiveTopBarButtons()
        PhoneTopBarAction(
            glyph = R.string.tally_player_glyph_subtitles,
            label = stringResource(R.string.tally_player_subtitles),
            onClick = onSubtitles,
        )
        PhoneTopBarAction(
            glyph = R.string.tally_player_glyph_settings,
            label = stringResource(R.string.tally_player_settings),
            onClick = onSettings,
        )
    }
}

/**
 * Previous, back by the skip length, play/pause (64dp, accent frame), forward, next. A live channel has only
 * play/pause, as on the TV: there is nothing to skip through.
 */
@Composable
private fun Transport(
    player: Player,
    showPlay: Boolean,
    isLive: Boolean,
    previousEnabled: Boolean,
    nextEnabled: Boolean,
    seekBack: Duration,
    seekForward: Duration,
    skipBackOnResume: Duration?,
    onInteraction: () -> Unit,
    onPlaybackActionClick: (PlaybackAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(28.dp),
        modifier = modifier,
    ) {
        if (previousEnabled && !isLive) {
            TransportButton(
                glyph = stringResource(R.string.tally_player_glyph_previous),
                label = stringResource(R.string.tally_player_previous),
                onClick = {
                    onInteraction()
                    onPlaybackActionClick(PlaybackAction.Previous)
                },
            )
        }
        if (!isLive) {
            TransportButton(
                glyph = stringResource(R.string.fa_rotate_left),
                label = stringResource(R.string.tally_player_rewind),
                caption = "${seekBack.inWholeSeconds}s",
                onClick = {
                    onInteraction()
                    player.seekBack(seekBack)
                },
            )
        }
        val playLabel = stringResource(if (showPlay) R.string.tally_player_play else R.string.tally_player_pause)
        Box(
            contentAlignment = Alignment.Center,
            modifier =
                Modifier
                    .size(64.dp)
                    .background(Color.Black.copy(alpha = 0.35f))
                    .border(2.dp, TallyColors.accent)
                    .semantics { contentDescription = playLabel }
                    .phoneClickable {
                        onInteraction()
                        if (showPlay) {
                            player.play()
                            skipBackOnResume?.let { player.seekBack(it) }
                        } else {
                            player.pause()
                        }
                    },
        ) {
            Text(
                text =
                    stringResource(
                        if (showPlay) R.string.tally_player_glyph_play else R.string.tally_player_glyph_pause,
                    ),
                fontFamily = FontAwesome,
                fontSize = 24.sp,
                color = TallyColors.text,
                maxLines = 1,
            )
        }
        if (!isLive) {
            TransportButton(
                glyph = stringResource(R.string.fa_rotate_right),
                label = stringResource(R.string.tally_player_fast_forward),
                caption = "${seekForward.inWholeSeconds}s",
                onClick = {
                    onInteraction()
                    player.seekForward(seekForward)
                },
            )
        }
        if (nextEnabled && !isLive) {
            TransportButton(
                glyph = stringResource(R.string.tally_player_glyph_next),
                label = stringResource(R.string.tally_player_next),
                onClick = {
                    onInteraction()
                    onPlaybackActionClick(PlaybackAction.Next)
                },
            )
        }
    }
}

/** A 56dp glyph button of the transport; [caption] (the skip length, `10s`) sits under the glyph. */
@Composable
private fun TransportButton(
    glyph: String,
    label: String,
    onClick: () -> Unit,
    caption: String? = null,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier =
            Modifier
                .size(56.dp)
                .semantics { contentDescription = label }
                .phoneClickable(onClick = onClick),
    ) {
        Text(
            text = glyph,
            fontFamily = FontAwesome,
            fontSize = 22.sp,
            color = TallyColors.text,
            maxLines = 1,
        )
        if (caption != null) {
            Text(
                text = caption,
                style = PhoneType.label.copy(letterSpacing = 0.sp),
                color = TallyColors.text,
                maxLines = 1,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

/** SKIP INTRO / SKIP CREDITS while the controls are up: mono on `ground`, 1dp `ruleStrong`, 48dp tall. */
@Composable
internal fun PhoneSkipButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier =
            modifier
                .height(PhoneDimens.touchTarget)
                .background(TallyColors.ground.copy(alpha = 0.85f))
                .border(PhoneDimens.hairline, TallyColors.ruleStrong)
                .phoneClickable(onClick = onClick)
                .padding(horizontal = 18.dp),
    ) {
        Text(
            text = label.tallyUppercase(),
            style = PhoneType.labelLarge,
            color = TallyColors.text,
            maxLines = 1,
        )
    }
}

/**
 * The Tally seek bar on a phone: the elapsed time (the drag target while dragging) at the left, the TV's track in the
 * middle (a 48dp tall touch area), the time left at the right, all mono. Dragging moves the scrubber with the finger
 * and shows the trickplay thumbnail over it; letting go seeks. A tap on the track seeks there.
 */
@Composable
private fun PhoneSeekBar(
    player: Player,
    chapters: List<Chapter>,
    enabled: Boolean,
    controllerViewState: ControllerViewState,
    showPlay: Boolean,
    trickplayInfo: TrickplayInfo?,
    trickplayUrlFor: (Int) -> String?,
) {
    val progress = rememberPlayerProgress(player)
    var target by remember { mutableStateOf<Long?>(null) }
    // After letting go, the polled position lags a moment: keep showing the target until it arrives.
    var settling by remember { mutableLongStateOf(-1L) }
    LaunchedEffect(settling) {
        if (settling >= 0) {
            delay(600)
            settling = -1L
        }
    }
    val shownMs = target ?: settling.takeIf { it >= 0 } ?: progress.position
    val showPlayNow by rememberUpdatedState(showPlay)
    val chapterName =
        remember(chapters, shownMs) {
            PlayerFormat
                .chapterAt(chapters.map { it.position.inWholeMilliseconds }, shownMs)
                ?.let { chapters[it].name }
        }
    var trackWidth by remember { mutableStateOf(0) }

    fun msAt(x: Float): Long {
        if (trackWidth <= 0 || progress.duration <= 0) return 0L
        return ((x / trackWidth).coerceIn(0f, 1f) * progress.duration).toLong()
    }

    fun seekTo(ms: Long) {
        player.seekTo(ms)
        settling = ms
    }
    val timeStyle = PhoneType.meta.copy(fontSize = 13.sp, letterSpacing = 0.5.sp)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = PlayerFormat.clock(shownMs),
            style = timeStyle,
            color = if (target != null) TallyColors.accent else TallyColors.text,
            maxLines = 1,
            modifier = Modifier.width(60.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            if (target != null) {
                PreviewAbove(fraction = progress.fraction(shownMs), gap = 4.dp) {
                    TallyTrickplayPreview(
                        positionMs = shownMs,
                        trickplayInfo = trickplayInfo,
                        trickplayUrlFor = trickplayUrlFor,
                        chapterName = chapterName,
                    )
                }
            }
            Box(
                contentAlignment = Alignment.Center,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(PhoneDimens.touchTarget)
                        .onSizeChanged { trackWidth = it.width }
                        .then(
                            if (enabled) {
                                Modifier
                                    .pointerInput(Unit) {
                                        detectTapGestures(onTap = { offset ->
                                            seekTo(msAt(offset.x))
                                            controllerViewState.pulseControls(
                                                if (showPlayNow) Long.MAX_VALUE else PHONE_CONTROLS_MS,
                                            )
                                        })
                                    }.pointerInput(Unit) {
                                        detectHorizontalDragGestures(
                                            onDragStart = { offset ->
                                                target = msAt(offset.x)
                                                controllerViewState.pulseControls(Long.MAX_VALUE)
                                            },
                                            onDragEnd = {
                                                target?.let { seekTo(it) }
                                                target = null
                                                controllerViewState.pulseControls(
                                                    if (showPlayNow) Long.MAX_VALUE else PHONE_CONTROLS_MS,
                                                )
                                            },
                                            onDragCancel = {
                                                target = null
                                                controllerViewState.pulseControls(
                                                    if (showPlayNow) Long.MAX_VALUE else PHONE_CONTROLS_MS,
                                                )
                                            },
                                            onHorizontalDrag = { change, _ ->
                                                change.consume()
                                                target = msAt(change.position.x)
                                            },
                                        )
                                    }
                            } else {
                                Modifier
                            },
                        ),
            ) {
                TrackCanvas(
                    progress = progress.fraction(shownMs),
                    buffered = progress.fraction(progress.buffered),
                    ticks = chapters.map { progress.fraction(it.position.inWholeMilliseconds) },
                    scrubber = if (target != null) 18.dp else 14.dp,
                    modifier = Modifier.fillMaxWidth().height(20.dp),
                )
            }
        }
        Text(
            text = if (progress.duration > 0) PlayerFormat.remaining(shownMs, progress.duration) else "",
            style = timeStyle,
            color = TallyColors.textSecondary,
            maxLines = 1,
            textAlign = androidx.compose.ui.text.style.TextAlign.End,
            modifier = Modifier.width(60.dp),
        )
    }
}
