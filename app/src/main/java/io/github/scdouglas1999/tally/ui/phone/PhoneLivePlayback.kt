package io.github.scdouglas1999.tally.ui.phone

import android.os.SystemClock
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.preferences.UserPreferences
import com.github.damontecres.wholphin.ui.nav.Destination
import com.github.damontecres.wholphin.ui.playback.PlaybackPage
import com.github.damontecres.wholphin.ui.playback.PlaybackViewModel
import com.github.damontecres.wholphin.ui.showToast
import dagger.hilt.android.EntryPointAccessors
import io.github.scdouglas1999.tally.api.TallyEvent
import io.github.scdouglas1999.tally.api.TallyTeam
import io.github.scdouglas1999.tally.data.isFollowed
import io.github.scdouglas1999.tally.dvr.ui.rememberStartOverAction
import io.github.scdouglas1999.tally.ui.CornerBoardEntryPoint
import io.github.scdouglas1999.tally.ui.TuneIn
import io.github.scdouglas1999.tally.ui.components.GameActionsDialog
import io.github.scdouglas1999.tally.ui.components.gameActions
import io.github.scdouglas1999.tally.ui.components.phone.PhoneGameCard
import io.github.scdouglas1999.tally.ui.components.phone.PhoneGamePanel
import io.github.scdouglas1999.tally.ui.player.TallyPlayerViewModel
import io.github.scdouglas1999.tally.ui.player.controls.phone.playerStatusStrip
import io.github.scdouglas1999.tally.ui.player.gamelessChannelGames
import io.github.scdouglas1999.tally.ui.player.phone.LiveTopBarAction
import io.github.scdouglas1999.tally.ui.player.phone.LiveTopBarActions
import io.github.scdouglas1999.tally.ui.player.phone.LocalLiveTopBarActions
import io.github.scdouglas1999.tally.ui.player.phone.PhoneEventBanner
import io.github.scdouglas1999.tally.ui.player.phone.PhoneLivePanel
import io.github.scdouglas1999.tally.ui.player.phone.PhoneScoreBug
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import kotlinx.coroutines.delay

/** What is open over the live picture. */
private enum class LivePanel { GAMES, BOX_SCORE }

/** The score bug and the banner sit this far from the picture's edges. */
private val OverlayMargin = 16.dp

/**
 * Height of the phone controls' top bar (a 48dp row with 8dp around it) under the status strip: the bug moves under
 * it while it shows.
 */
private val ControlsTopBar = 64.dp

private const val BUG_LINGER_MS = 8_000L
private const val FADE_MS = 140

/**
 * The live player on a phone ([io.github.scdouglas1999.tally.ui.TallyPlaybackPage]'s phone layout): landscape, the
 * same upstream player and view models as on the TV (so the shared phone controls, tap to show, no seek bar on a live
 * stream, are the player's own), the tune-in card, and over the picture:
 * - the score bug in the top-left corner, shown as on the TV (on opening, when the score or situation changes, while
 *   the controls show, and for a while after), moving under the controls' top bar while they show;
 * - the event banner (a notable play in another game) in the top-right corner;
 * - GAMES and BOX SCORE in the controls' top bar ([LiveTopBarActions]), each opening a [PhoneLivePanel] from the
 *   right: the other live games (a tap switches, a long-press opens the game sheet) and the box score.
 * The corner view is not offered on a phone.
 */
@Composable
fun PhoneLivePlayback(
    preferences: UserPreferences,
    destination: Destination.TallyPlayback,
    modifier: Modifier = Modifier,
) {
    // Landscape and full screen come with upstream's player (PhonePlayerWindow at the top of PlaybackPage), which
    // holds them across a switch to another game.
    val viewModel = hiltViewModel<TallyPlayerViewModel>()
    LaunchedEffect(destination.channelId) { viewModel.bind(destination.channelId) }

    val game by viewModel.game.collectAsState()
    val others by viewModel.others.collectAsState()
    val banner by viewModel.banner.collectAsState()
    val hideScores by viewModel.hideScores.collectAsState()
    val favorites by viewModel.favorites.collectAsState()
    val favoriteTeams by viewModel.favoriteTeams.collectAsState()

    val context = LocalContext.current
    val repository =
        remember(context) {
            EntryPointAccessors
                .fromApplication(context.applicationContext, CornerBoardEntryPoint::class.java)
                .tallyRepository()
        }
    val board by repository.board.collectAsState()
    LaunchedEffect(Unit) {
        viewModel.messages.collect { showToast(context, context.getString(it), Toast.LENGTH_SHORT) }
    }

    // Other live games when there are any; with none, the looping channels (as the TV switcher).
    val switcherGames = if (others.isNotEmpty()) others else gamelessChannelGames(board, destination.channelId)
    var panel by remember { mutableStateOf<LivePanel?>(null) }
    var sheetGameId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(switcherGames.isEmpty(), game == null) {
        if (panel == LivePanel.GAMES && switcherGames.isEmpty()) panel = null
        if (panel == LivePanel.BOX_SCORE && game == null) panel = null
    }
    BackHandler(enabled = panel != null) { panel = null }

    // The same view model PlaybackPage would create for itself (same call, same destination), as on the TV.
    val playbackDestination =
        remember(destination.itemId) { Destination.Playback(itemId = destination.itemId, positionMs = 0L) }
    val playbackViewModel =
        hiltViewModel<PlaybackViewModel, PlaybackViewModel.Factory>(
            creationCallback = { it.create(playbackDestination) },
        )
    val controlsVisible = playbackViewModel.controllerViewState.controlsVisible

    val gamesLabel = stringResource(R.string.tally_phone_sports_games)
    val boxLabel = stringResource(R.string.tally_phone_sports_box_score)
    val startOverLabel = stringResource(R.string.tally_dvr_watch_from_start)
    // While the game on screen is being recorded: WATCH FROM THE START, first in the controls' top bar.
    val startOver = rememberStartOverAction(game)
    val topBar = remember { LiveTopBarActions() }
    topBar.actions =
        buildList {
            if (startOver != null) {
                add(LiveTopBarAction(R.string.tally_dvr_fa_start_over, startOverLabel, startOver))
            }
            if (switcherGames.isNotEmpty()) {
                add(LiveTopBarAction(R.string.tally_phone_sports_fa_trophy, gamesLabel) { panel = LivePanel.GAMES })
            }
            if (game != null) {
                add(LiveTopBarAction(R.string.tally_phone_sports_fa_box_score, boxLabel) { panel = LivePanel.BOX_SCORE })
            }
        }

    Box(modifier) {
        CompositionLocalProvider(LocalLiveTopBarActions provides topBar) {
            PlaybackPage(
                preferences = preferences,
                destination = playbackDestination,
                modifier = Modifier.fillMaxSize(),
                viewModel = playbackViewModel,
            )
        }
        TuneIn(
            viewModel = playbackViewModel,
            title = game?.let { stringResource(R.string.tally_lamp_matchup, it.away.tuneInName(), it.home.tuneInName()) },
        )

        val safe = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)
        // Under the controls' top bar while it shows, in the corner otherwise.
        val overlayTop by animateDpAsState(
            targetValue = if (controlsVisible) playerStatusStrip() + ControlsTopBar else OverlayMargin,
            animationSpec = tween(FADE_MS),
            label = "liveOverlayTop",
        )

        // The bug: shown on opening, when the score, period or situation changes, while the controls or the switcher
        // are up, and for BUG_LINGER_MS after; always composed and faded, so a score change can roll.
        var bugShownAt by remember { mutableStateOf(SystemClock.elapsedRealtime()) }
        val bugKey = game?.let { "${it.away.score}-${it.home.score}|${it.detail}|${it.downDistance}" }
        LaunchedEffect(bugKey, controlsVisible) { bugShownAt = SystemClock.elapsedRealtime() }
        var bugVisible by remember { mutableStateOf(true) }
        LaunchedEffect(bugShownAt, panel, controlsVisible) {
            bugVisible = panel != LivePanel.BOX_SCORE
            if (panel == null && !controlsVisible) {
                delay(BUG_LINGER_MS)
                bugVisible = false
            }
        }
        val bugAlpha by animateFloatAsState(
            targetValue = if (bugVisible) 1f else 0f,
            animationSpec = tween(if (bugVisible) FADE_MS else FADE_MS * 3),
            label = "phoneScoreBugAlpha",
        )
        Box(safe) {
            PhoneScoreBug(
                game = game,
                hideScores = hideScores,
                modifier =
                    Modifier
                        .align(Alignment.TopStart)
                        .padding(start = OverlayMargin, top = overlayTop)
                        .graphicsLayer { alpha = bugAlpha },
            )

            var lastBanner by remember { mutableStateOf<TallyEvent?>(null) }
            LaunchedEffect(banner) { if (banner != null) lastBanner = banner }
            lastBanner?.let {
                PhoneEventBanner(
                    event = it,
                    visible = banner != null,
                    modifier =
                        Modifier
                            .align(Alignment.TopEnd)
                            .padding(end = OverlayMargin, top = overlayTop),
                )
            }
        }

        PhoneLivePanel(
            visible = panel == LivePanel.GAMES,
            title = stringResource(R.string.tally_player_also_on_now),
            count = switcherGames.size,
            onClose = { panel = null },
        ) {
            LazyColumn(
                contentPadding = PaddingValues(start = PhoneDimens.margin, end = PhoneDimens.margin, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(PhoneDimens.cardGap),
                modifier = Modifier.fillMaxWidth().weight(1f),
            ) {
                items(switcherGames, key = { it.id }) { other ->
                    PhoneGameCard(
                        game = other,
                        hideScores = hideScores,
                        isFavorite = other.watch?.channelId in favorites || other.isFollowed(favoriteTeams),
                        followed = other.isFollowed(favoriteTeams),
                        onClick = {
                            panel = null
                            viewModel.switchTo(other)
                        },
                        // A channel with no game (nothing live) has no sheet: its TV long-press puts it in the corner.
                        onLongClick = { if (others.isNotEmpty()) sheetGameId = other.id },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        PhoneLivePanel(
            visible = panel == LivePanel.BOX_SCORE,
            title = stringResource(R.string.tally_phone_sports_box_score),
            onClose = { panel = null },
        ) {
            game?.let { shown ->
                PhoneGamePanel(
                    game = shown,
                    hideScores = hideScores,
                    modifier =
                        Modifier
                            .weight(1f)
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = PhoneDimens.margin)
                            .padding(bottom = 16.dp),
                )
            }
        }

        val sheetGame = sheetGameId?.let { id -> others.firstOrNull { it.id == id } }
        if (sheetGame != null) {
            GameActionsDialog(
                game = sheetGame,
                actions =
                    gameActions(
                        game = sheetGame,
                        favoriteTeams = favoriteTeams,
                        hideScores = hideScores,
                        onWatch = {
                            panel = null
                            viewModel.switchTo(it)
                        },
                        onAddToMultiview = viewModel::addToMultiview,
                        onWatchInCorner = null,
                        onToggleFollow = viewModel::toggleFollow,
                        onToggleHideScores = viewModel::toggleHideScores,
                    ),
                onDismiss = { sheetGameId = null },
            )
        }
    }
}

private fun TallyTeam.tuneInName(): String = shortName.ifBlank { abbr.ifBlank { name } }
