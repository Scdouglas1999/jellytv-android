package io.github.scdouglas1999.tally.dvr.ui.phone

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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.ui.FontAwesome
import io.github.scdouglas1999.tally.dvr.ui.START_OVER_BACK_MS
import io.github.scdouglas1999.tally.dvr.ui.START_OVER_FORWARD_MS
import io.github.scdouglas1999.tally.dvr.ui.StartOverKicker
import io.github.scdouglas1999.tally.dvr.ui.StartOverPicture
import io.github.scdouglas1999.tally.dvr.ui.StartOverPlayback
import io.github.scdouglas1999.tally.dvr.ui.behindLiveText
import io.github.scdouglas1999.tally.ui.components.tallyUppercase
import io.github.scdouglas1999.tally.ui.phone.PhoneTopBarAction
import io.github.scdouglas1999.tally.ui.phone.phoneClickable
import io.github.scdouglas1999.tally.ui.phone.phoneSystemBack
import io.github.scdouglas1999.tally.ui.player.controls.PlayerFormat
import io.github.scdouglas1999.tally.ui.player.controls.TrackCanvas
import io.github.scdouglas1999.tally.ui.player.controls.phone.PhonePlayerWindow
import io.github.scdouglas1999.tally.ui.player.controls.phone.playerTopBarInset
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import io.github.scdouglas1999.tally.ui.theme.PhoneType
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import kotlinx.coroutines.delay

private const val CONTROLS_MS = 4_000L
private const val FADE_MS = 150

/**
 * WATCH FROM THE START on a phone: landscape and full screen like the player. A tap shows or hides the controls
 * (they hide after a few seconds while playing): back, the `■ REC · FROM THE START` kicker and the title at the top;
 * back 10 s, play/pause and forward 30 s in the middle; at the bottom the seek bar over what has been recorded so
 * far (drag or tap to seek), the position and how far behind live, and LIVE.
 */
@Composable
fun PhoneStartOverPage(
    playback: StartOverPlayback,
    title: String,
    modifier: Modifier = Modifier,
) {
    PhonePlayerWindow()
    var controls by remember { mutableStateOf(true) }
    var touchedAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(controls, touchedAt, playback.playing) {
        if (controls && playback.playing) {
            delay(CONTROLS_MS)
            controls = false
        }
    }
    val touch = { touchedAt = System.currentTimeMillis() }
    val back = phoneSystemBack()
    Box(
        modifier =
            modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) { detectTapGestures(onTap = { controls = !controls }) },
    ) {
        StartOverPicture(playback, title)
        AnimatedVisibility(
            visible = controls,
            enter = fadeIn(tween(FADE_MS)),
            exit = fadeOut(tween(FADE_MS)),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(Modifier.fillMaxSize()) {
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
                Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.displayCutout)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier =
                            Modifier
                                .align(Alignment.TopCenter)
                                .fillMaxWidth()
                                .playerTopBarInset()
                                .padding(8.dp),
                    ) {
                        PhoneTopBarAction(
                            glyph = R.string.tally_phone_fa_arrow_left,
                            label = stringResource(R.string.tally_phone_back),
                            onClick = { back?.invoke() },
                        )
                        Spacer(Modifier.width(4.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = title,
                                style = PhoneType.headline,
                                color = TallyColors.text,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            StartOverKicker(PhoneType.label)
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(28.dp),
                        modifier = Modifier.align(Alignment.Center),
                    ) {
                        SkipButton(
                            glyph = stringResource(R.string.fa_rotate_left),
                            label = stringResource(R.string.tally_dvr_back_10),
                            caption = "${START_OVER_BACK_MS / 1000}s",
                        ) {
                            touch()
                            playback.seekBy(-START_OVER_BACK_MS)
                        }
                        val playLabel = stringResource(if (playback.playing) R.string.tally_player_pause else R.string.tally_player_play)
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier =
                                Modifier
                                    .size(64.dp)
                                    .background(Color.Black.copy(alpha = 0.35f))
                                    .border(2.dp, TallyColors.accent)
                                    .semantics { contentDescription = playLabel }
                                    .phoneClickable {
                                        touch()
                                        playback.togglePlay()
                                    },
                        ) {
                            Text(
                                text =
                                    stringResource(
                                        if (playback.playing) R.string.tally_player_glyph_pause else R.string.tally_player_glyph_play,
                                    ),
                                fontFamily = FontAwesome,
                                fontSize = 24.sp,
                                color = TallyColors.text,
                                maxLines = 1,
                            )
                        }
                        SkipButton(
                            glyph = stringResource(R.string.fa_rotate_right),
                            label = stringResource(R.string.tally_dvr_forward_30),
                            caption = "${START_OVER_FORWARD_MS / 1000}s",
                        ) {
                            touch()
                            playback.seekBy(START_OVER_FORWARD_MS)
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        modifier =
                            Modifier
                                .align(Alignment.BottomCenter)
                                .fillMaxWidth()
                                .padding(horizontal = PhoneDimens.margin)
                                .padding(bottom = 12.dp),
                    ) {
                        PhoneStartOverSeekBar(playback = playback, onTouch = touch, modifier = Modifier.weight(1f))
                        if (!playback.atLive) {
                            LiveButton {
                                touch()
                                playback.jumpToLive()
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The seek bar over the recorded span: the position at the left (the drag target while dragging), the TV's track
 * (48dp tall touch area), "-12:30 BEHIND LIVE" or LIVE at the right. Drag moves the scrubber; letting go seeks; a
 * tap seeks there.
 */
@Composable
private fun PhoneStartOverSeekBar(
    playback: StartOverPlayback,
    onTouch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var target by remember { mutableStateOf<Long?>(null) }
    var width by remember { mutableIntStateOf(0) }

    fun msAt(x: Float): Long = if (width <= 0 || playback.duration <= 0) 0L else ((x / width).coerceIn(0f, 1f) * playback.duration).toLong()
    val shown = target ?: playback.position
    val timeStyle = PhoneType.meta.copy(fontSize = 13.sp, letterSpacing = 0.5.sp)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
        Text(
            text = PlayerFormat.clock(shown),
            style = timeStyle,
            color = if (target != null) TallyColors.accent else TallyColors.text,
            maxLines = 1,
            modifier = Modifier.width(64.dp),
        )
        Box(
            contentAlignment = Alignment.Center,
            modifier =
                Modifier
                    .weight(1f)
                    .height(PhoneDimens.touchTarget)
                    .onSizeChanged { width = it.width }
                    .pointerInput(Unit) {
                        detectTapGestures(onTap = { offset ->
                            onTouch()
                            playback.seekTo(msAt(offset.x))
                        })
                    }.pointerInput(Unit) {
                        detectHorizontalDragGestures(
                            onDragStart = { offset ->
                                onTouch()
                                target = msAt(offset.x)
                            },
                            onDragEnd = {
                                target?.let { playback.seekTo(it) }
                                target = null
                                onTouch()
                            },
                            onDragCancel = { target = null },
                            onHorizontalDrag = { change, _ ->
                                change.consume()
                                target = msAt(change.position.x)
                                onTouch()
                            },
                        )
                    },
        ) {
            TrackCanvas(
                progress = playback.fraction(shown),
                buffered = playback.fraction(playback.buffered),
                ticks = emptyList(),
                scrubber = if (target != null) 18.dp else 14.dp,
                modifier = Modifier.fillMaxWidth().height(20.dp),
            )
        }
        Text(
            text = behindLiveText(playback).tallyUppercase(),
            style = timeStyle,
            color = if (playback.atLive) TallyColors.accent else TallyColors.textSecondary,
            maxLines = 1,
            textAlign = TextAlign.End,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/** LIVE: jumps to the newest minute (shown only while behind it; at live the time says LIVE in accent). */
@Composable
private fun LiveButton(onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier =
            Modifier
                .height(PhoneDimens.touchTarget)
                .border(PhoneDimens.hairline, TallyColors.ruleStrong)
                .phoneClickable(onClick = onClick)
                .padding(horizontal = 16.dp),
    ) {
        Text(
            text = stringResource(R.string.tally_dvr_live).tallyUppercase(),
            style = PhoneType.labelLarge,
            color = TallyColors.text,
            maxLines = 1,
        )
    }
}

/** A 56dp glyph button with the skip length under it (`10s`). */
@Composable
private fun SkipButton(
    glyph: String,
    label: String,
    caption: String,
    onClick: () -> Unit,
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
        Text(text = glyph, fontFamily = FontAwesome, fontSize = 22.sp, color = TallyColors.text, maxLines = 1)
        Text(
            text = caption,
            style = PhoneType.label.copy(letterSpacing = 0.sp),
            color = TallyColors.text,
            maxLines = 1,
            modifier = Modifier.padding(top = 3.dp),
        )
    }
}
