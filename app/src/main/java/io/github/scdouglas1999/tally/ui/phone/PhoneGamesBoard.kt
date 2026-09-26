package io.github.scdouglas1999.tally.ui.phone

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import io.github.scdouglas1999.tally.data.BoardOrganizer
import io.github.scdouglas1999.tally.data.isFollowed
import io.github.scdouglas1999.tally.media.kit.phone.PhoneEmptyState
import io.github.scdouglas1999.tally.media.kit.phone.PhoneLoading
import io.github.scdouglas1999.tally.media.kit.phone.PhoneRowHeader
import io.github.scdouglas1999.tally.ui.TallyUiState
import io.github.scdouglas1999.tally.ui.TallyViewModel
import io.github.scdouglas1999.tally.ui.components.GameActionsDialog
import io.github.scdouglas1999.tally.ui.components.gameActions
import io.github.scdouglas1999.tally.ui.components.phone.PhoneGameCard
import io.github.scdouglas1999.tally.ui.components.tallyUppercase
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import io.github.scdouglas1999.tally.ui.theme.PhoneType
import io.github.scdouglas1999.tally.ui.theme.TallyColors

/**
 * The games board on a phone: the TV board's rows in its order, stacked: each row's header as on the TV
 * (`MLB / LIVE 3`) over its games as full-width [PhoneGameCard]s (on a tablet as many across as fit, each at most
 * [PhoneDimens.gameCardMaxWidth]). A tap or a long-press on a game opens its game sheet
 * (the TV's focused-game panel and game menu in one). The TV's loading, failed, filtered and empty states, and the
 * one-line notice naming the leagues whose feeds failed.
 */
@Composable
internal fun PhoneGamesBoard(
    state: TallyUiState,
    viewModel: TallyViewModel,
    modifier: Modifier = Modifier,
) {
    var sheetGameId by rememberSaveable { mutableStateOf<String?>(null) }
    val rows = state.rows
    when {
        state.loading -> {
            PhoneLoading(modifier)
        }

        state.boardError != null && !state.hasBoard -> {
            PhoneEmptyState(
                title = stringResource(R.string.tally_board_failed_title),
                subtitle = state.boardError,
                modifier = modifier,
            )
        }

        rows.isEmpty() && state.games.isNotEmpty() -> {
            PhoneEmptyState(
                title = stringResource(R.string.tally_empty_filtered_title),
                subtitle = stringResource(R.string.tally_empty_filtered_sub),
                modifier = modifier,
            )
        }

        rows.isEmpty() -> {
            PhoneEmptyState(
                title = stringResource(R.string.tally_empty_games_title),
                subtitle = stringResource(R.string.tally_empty_games_sub),
                modifier = modifier,
            )
        }

        else -> {
            val bottom = LocalPhoneContentPadding.current.calculateBottomPadding()
            val screenWidth = LocalConfiguration.current.screenWidthDp.dp
            val columns = phoneGameColumns(screenWidth)
            val cardWidth = phoneGameCardWidth(screenWidth, columns)
            LazyColumn(
                state = rememberLazyListState(),
                contentPadding = PaddingValues(top = 12.dp, bottom = bottom + PhoneDimens.rowGap),
                modifier = modifier,
            ) {
                if (state.feedErrors.isNotEmpty()) {
                    item(key = "feed-errors") {
                        Text(
                            text =
                                stringResource(R.string.tally_feeds_failed, state.feedErrors.keys.joinToString(", "))
                                    .tallyUppercase(),
                            style = PhoneType.label,
                            color = TallyColors.liveText,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier =
                                Modifier
                                    .padding(horizontal = PhoneDimens.margin)
                                    .padding(bottom = 16.dp)
                                    .fillMaxWidth()
                                    .border(PhoneDimens.hairline, TallyColors.live)
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                rows.forEachIndexed { index, row ->
                    item(key = "header-" + row.key) {
                        PhoneRowHeader(
                            title = "${row.league} / ${rowStateLabel(row.state)}",
                            count = row.games.size,
                            modifier =
                                Modifier
                                    .padding(horizontal = PhoneDimens.margin)
                                    .padding(top = if (index == 0) 0.dp else PhoneDimens.rowGap - PhoneDimens.cardGap),
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    // a tablet: games side by side, each at most gameCardMaxWidth, so a card never stretches
                    items(row.games.chunked(columns), key = { row.key + "|" + it.first().id }) { pair ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(PhoneDimens.cardGap),
                            modifier =
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = PhoneDimens.margin)
                                    .padding(bottom = PhoneDimens.cardGap),
                        ) {
                            pair.forEach { game ->
                                PhoneGameCard(
                                    game = game,
                                    hideScores = state.hideScores,
                                    isFavorite =
                                        game.watch?.channelId in state.favorites || game.isFollowed(state.favoriteTeams),
                                    followed = game.isFollowed(state.favoriteTeams),
                                    onClick = { sheetGameId = game.id },
                                    onLongClick = { sheetGameId = game.id },
                                    modifier = if (cardWidth != null) Modifier.width(cardWidth) else Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    val sheetGame = state.games.firstOrNull { it.id == sheetGameId }
    if (sheetGame != null) {
        GameActionsDialog(
            game = sheetGame,
            actions =
                gameActions(
                    game = sheetGame,
                    favoriteTeams = state.favoriteTeams,
                    hideScores = state.hideScores,
                    onWatch = viewModel::watch,
                    onAddToMultiview = { game -> game.watch?.channelId?.let(viewModel::addToMultiview) },
                    onWatchInCorner = null,
                    onToggleFollow = viewModel::toggleFollow,
                    onToggleHideScores = { viewModel.setHideScores(!state.hideScores) },
                ),
            onDismiss = { sheetGameId = null },
        )
    }
}

/** One game across a phone; on a tablet as many columns as fit cards at least [PhoneDimens.gameCardWidth] wide. */
internal fun phoneGameColumns(screenWidth: Dp): Int {
    if (screenWidth < PhoneDimens.twoColumnMinWidth) return 1
    val available = screenWidth - PhoneDimens.margin * 2
    return ((available + PhoneDimens.cardGap) / (PhoneDimens.gameCardWidth + PhoneDimens.cardGap)).toInt().coerceAtLeast(2)
}

/** A tablet's card width for [columns] across (at most [PhoneDimens.gameCardMaxWidth]); null on a phone (full width). */
internal fun phoneGameCardWidth(
    screenWidth: Dp,
    columns: Int,
): Dp? {
    if (columns < 2) return null
    val available = screenWidth - PhoneDimens.margin * 2
    return minOf((available - PhoneDimens.cardGap * (columns - 1)) / columns, PhoneDimens.gameCardMaxWidth)
}

@Composable
private fun rowStateLabel(state: String): String =
    when (state) {
        "in" -> stringResource(R.string.tally_state_live)
        "pre" -> stringResource(R.string.tally_state_upcoming)
        "post" -> stringResource(R.string.tally_final)
        BoardOrganizer.POSTPONED -> stringResource(R.string.tally_polish2_state_postponed)
        else -> state
    }
