package io.github.scdouglas1999.tally.dvr.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Glow
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.ui.tryRequestFocus
import io.github.scdouglas1999.tally.api.TallyTeam
import io.github.scdouglas1999.tally.dvr.DvrJob
import io.github.scdouglas1999.tally.dvr.DvrList
import io.github.scdouglas1999.tally.dvr.DvrRule
import io.github.scdouglas1999.tally.dvr.DvrState
import io.github.scdouglas1999.tally.dvr.DvrViewModel
import io.github.scdouglas1999.tally.dvr.GameRecordingView
import io.github.scdouglas1999.tally.dvr.recordingStateText
import io.github.scdouglas1999.tally.media.kit.LandscapeCard
import io.github.scdouglas1999.tally.media.kit.tallyClickable
import io.github.scdouglas1999.tally.ui.LocalTallyUpTarget
import io.github.scdouglas1999.tally.ui.components.EmptyState
import io.github.scdouglas1999.tally.ui.components.IndicatorSquare
import io.github.scdouglas1999.tally.ui.components.KeyHint
import io.github.scdouglas1999.tally.ui.components.RowHeader
import io.github.scdouglas1999.tally.ui.components.tallyUppercase
import io.github.scdouglas1999.tally.ui.formfactor.tallyFocusVisible
import io.github.scdouglas1999.tally.ui.settings.TallyConfirmDeleteDialog
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import io.github.scdouglas1999.tally.ui.theme.TallyDimens
import io.github.scdouglas1999.tally.ui.theme.TallyType
import io.github.scdouglas1999.tally.ui.upToTab

/**
 * RECORDINGS, the Sports tab after MULTIVIEW on a TV (only when the server records): the storage line, then
 * RECORDING NOW (OK watches from the start, HOLD for stop), SCHEDULED (OK to cancel), RECORDED (a row of 16:9
 * cards with the matchup art, "Otters at Herons", the date and length; OK plays, HOLD for delete), FAILED (the
 * reason; OK dismisses) and TEAM RULES (keep-last; OK to change it or delete the rule). Without the permission to
 * record, rows only show; nothing is offered but watching. Never a score anywhere.
 */
@Composable
fun RecordingsTab(modifier: Modifier = Modifier) {
    val viewModel = hiltViewModel<DvrViewModel>()
    RecordingsTabEffects(viewModel)
    val list by viewModel.list.collectAsState()
    val storage by viewModel.storage.collectAsState()
    val error by viewModel.error.collectAsState()
    val context = LocalContext.current

    var menuJob by remember { mutableStateOf<DvrJob?>(null) }
    var keepRule by remember { mutableStateOf<DvrRule?>(null) }
    var confirmDelete by remember { mutableStateOf<DvrJob?>(null) }

    val current = list
    if (current == null) {
        EmptyState(
            title = stringResource(if (error != null) R.string.tally_dvr_list_failed else R.string.tally_dvr_loading),
            subtitle = error.orEmpty(),
            takeFocus = false,
            modifier = modifier.padding(horizontal = TallyDimens.marginHorizontal).padding(top = 24.dp),
        )
        return
    }
    val sections = RecordingsSections.of(current)
    val canManage = current.canManage
    val firstFocus = remember { FocusRequester() }
    LaunchedEffect(sections.isEmpty) {
        if (!sections.isEmpty) firstFocus.tryRequestFocus("tally-recordings")
    }
    val now = rememberSecondTick(active = sections.recordingNow.isNotEmpty())
    // The first element of the page takes the tab's initial focus and sends UP to the tabs.
    val firstKey =
        (sections.recordingNow + sections.scheduled + sections.recorded + sections.failed).firstOrNull()?.id
            ?: sections.rules.firstOrNull()?.id

    fun Modifier.firstOnPage(key: String): Modifier = if (key == firstKey) this.focusRequester(firstFocus).upToTab() else this

    // focus stays on this tab when the focused entry leaves the list (a recording finished, a job was canceled)
    val keepFocus = rememberRecordingsFocus()
    val listState = rememberLazyListState()
    keepFocus.layout(sections.focusOrder(), sections.lazyIndices())
    RecordingsFocusEffect(keepFocus, listState, LocalTallyUpTarget.current)

    LazyColumn(
        state = listState,
        verticalArrangement = Arrangement.spacedBy(10.dp),
        contentPadding = PaddingValues(top = 20.dp, bottom = TallyDimens.marginVertical),
        modifier = modifier.recordingsList(keepFocus),
    ) {
        item(key = "storage") {
            Text(
                text = storageLine(storage)?.tallyUppercase().orEmpty(),
                style = TallyType.label,
                color = TallyColors.muted,
                maxLines = 1,
                modifier = Modifier.padding(horizontal = TallyDimens.marginHorizontal),
            )
        }
        if (sections.isEmpty) {
            item(key = "empty") {
                EmptyState(
                    title = stringResource(R.string.tally_dvr_empty_title),
                    subtitle = stringResource(if (canManage) R.string.tally_dvr_empty_sub else R.string.tally_dvr_empty_sub_viewer),
                    takeFocus = false,
                    modifier = Modifier.padding(horizontal = TallyDimens.marginHorizontal).padding(top = 24.dp),
                )
            }
        }
        section(R.string.tally_dvr_section_now, sections.recordingNow) { job ->
            val startOver = job.startOverPath
            val title = jobTitle(job)
            DvrTvRow(
                title = title,
                meta = recordingNowMeta(job, now),
                indicator = TallyColors.live,
                onClick = {
                    if (startOver != null) viewModel.watchFromStart(job.id, startOver, title) else menuJob = job
                },
                onLongClick = { menuJob = job },
                modifier = Modifier.firstOnPage(job.id).recordingsEntry(keepFocus, job.id),
            ) {
                if (startOver !=
                    null
                ) {
                    KeyHint(key = stringResource(R.string.tally_key_ok), label = stringResource(R.string.tally_dvr_watch_from_start))
                }
                if (canManage &&
                    job.isRecording
                ) {
                    KeyHint(key = stringResource(R.string.tally_key_hold), label = stringResource(R.string.tally_dvr_stop))
                }
            }
        }
        section(R.string.tally_dvr_section_scheduled, sections.scheduled) { job ->
            DvrTvRow(
                title = jobTitle(job),
                meta = scheduledMeta(job, current.rules),
                indicator = TallyColors.ruleStrong,
                onClick = { if (canManage) menuJob = job },
                onLongClick = { if (canManage) menuJob = job },
                modifier = Modifier.firstOnPage(job.id).recordingsEntry(keepFocus, job.id),
            ) {
                if (canManage) KeyHint(key = stringResource(R.string.tally_key_ok), label = stringResource(R.string.tally_dvr_cancel))
            }
        }
        if (sections.recorded.isNotEmpty()) {
            item(key = "recorded-header") {
                SectionHeader(R.string.tally_dvr_section_recorded, sections.recorded.size)
            }
            item(key = "recorded-row") {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(TallyDimens.cardGap / 2),
                    contentPadding = PaddingValues(horizontal = TallyDimens.marginHorizontal),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    items(sections.recorded, key = { job -> job.id }) { job ->
                        LandscapeCard(
                            title = jobTitle(job),
                            kicker = recordedMeta(job),
                            imageUrl = recordingImageUrl(viewModel, job),
                            onClick = { playRecorded(viewModel, job, context) },
                            onLongClick = { menuJob = job },
                            modifier = Modifier.firstOnPage(job.id).recordingsEntry(keepFocus, job.id),
                        )
                    }
                }
            }
        }
        section(R.string.tally_dvr_section_failed, sections.failed) { job ->
            DvrTvRow(
                title = jobTitle(job),
                meta = recordingStateText(GameRecordingView(job.state, job.id, reason = job.reason)),
                metaColor = TallyColors.liveText,
                indicator = TallyColors.live,
                onClick = { if (canManage) viewModel.dismiss(job.id) },
                onLongClick = { if (canManage) viewModel.dismiss(job.id) },
                modifier = Modifier.firstOnPage(job.id).recordingsEntry(keepFocus, job.id),
            ) {
                if (canManage) KeyHint(key = stringResource(R.string.tally_key_ok), label = stringResource(R.string.tally_dvr_dismiss))
            }
        }
        section(R.string.tally_dvr_section_rules, sections.rules, key = { it.id }) { rule ->
            DvrTvRow(
                title = rule.title,
                meta = ruleMeta(rule, current),
                indicator = TallyColors.muted,
                onClick = { if (canManage) keepRule = rule },
                onLongClick = { if (canManage) keepRule = rule },
                modifier = Modifier.firstOnPage(rule.id).recordingsEntry(keepFocus, rule.id),
            ) {
                if (canManage) KeyHint(key = stringResource(R.string.tally_key_ok), label = stringResource(R.string.tally_dvr_change))
            }
        }
    }

    menuJob?.let { job -> JobMenu(job, canManage, viewModel, onDelete = { confirmDelete = it }, onDismiss = { menuJob = null }) }
    keepRule?.let { rule ->
        DvrKeepLastTvDialog(
            team = TallyTeam(id = rule.teamId.orEmpty(), name = rule.teamName.orEmpty()),
            rule = rule,
            onChoose = { keepLast -> viewModel.changeKeepLast(rule, rule.leagueForChange(), keepLast) },
            onDelete = { viewModel.deleteRule(rule.id) },
            onDismiss = { keepRule = null },
        )
    }
    confirmDelete?.let { job ->
        TallyConfirmDeleteDialog(
            itemTitle = jobTitle(job),
            onCancel = { confirmDelete = null },
            onConfirm = {
                confirmDelete = null
                viewModel.deleteRecording(job.id)
            },
        )
    }
}

/** A job's HOLD menu on a TV: watch from the start / stop, cancel, or play / delete a finished recording. */
@Composable
private fun JobMenu(
    job: DvrJob,
    canManage: Boolean,
    viewModel: DvrViewModel,
    onDelete: (DvrJob) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val title = jobTitle(job)
    val lines =
        buildList {
            val startOver = job.startOverPath
            when {
                job.state == DvrState.DONE -> {
                    add(
                        DvrMenuLine(
                            label = stringResource(R.string.tally_dvr_play),
                            dismiss = true,
                        ) { playRecorded(viewModel, job, context) },
                    )
                    if (canManage) add(DvrMenuLine(label = stringResource(R.string.tally_dvr_delete), dismiss = true) { onDelete(job) })
                }

                job.isRecording -> {
                    if (startOver != null) {
                        add(
                            DvrMenuLine(label = stringResource(R.string.tally_dvr_watch_from_start), dismiss = true) {
                                viewModel.watchFromStart(job.id, startOver, title)
                            },
                        )
                    }
                    if (canManage) {
                        add(
                            DvrMenuLine(
                                label = stringResource(R.string.tally_dvr_stop),
                                description = stringResource(R.string.tally_dvr_stop_keeps),
                                dismiss = true,
                            ) { viewModel.cancel(job.id) },
                        )
                    }
                }

                job.isPending && canManage -> {
                    add(DvrMenuLine(label = stringResource(R.string.tally_dvr_cancel), dismiss = true) { viewModel.cancel(job.id) })
                }
            }
        }
    if (lines.isEmpty()) {
        LaunchedEffect(Unit) { onDismiss() }
        return
    }
    DvrTvMenuDialog(
        kicker = job.game.league,
        title = title,
        lines = lines,
        onDismiss = onDismiss,
    )
}

private fun <T> LazyListScope.section(
    title: Int,
    items: List<T>,
    key: (T) -> Any = { (it as? DvrJob)?.id ?: it.hashCode() },
    row: @Composable (T) -> Unit,
) {
    if (items.isEmpty()) return
    item(key = "header-$title") { SectionHeader(title, items.size) }
    items(items, key = { "row-$title-" + key(it) }) { item ->
        Row(Modifier.padding(horizontal = TallyDimens.marginHorizontal)) { row(item) }
    }
}

@Composable
private fun SectionHeader(
    title: Int,
    count: Int,
) {
    RowHeader(
        title = stringResource(title),
        count = count,
        modifier = Modifier.padding(horizontal = TallyDimens.marginHorizontal).padding(top = 14.dp),
    )
}

/**
 * A Recordings row on a TV: an indicator square, the title (Sans) over a mono meta line, key hints at the right.
 * Focused: 3dp accent frame on `groundRaised`, as every Tally row.
 */
@Composable
private fun DvrTvRow(
    title: String,
    meta: String,
    indicator: Color,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    modifier: Modifier = Modifier,
    metaColor: Color = TallyColors.textSecondary,
    hints: @Composable RowScope.() -> Unit,
) {
    val showFocus = tallyFocusVisible()
    val idle = Border(BorderStroke(TallyDimens.hairline, TallyColors.ruleStrong), shape = RectangleShape)
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        shape = ClickableSurfaceDefaults.shape(RectangleShape),
        scale = ClickableSurfaceDefaults.scale(1f, 1f, 1f),
        colors =
            ClickableSurfaceDefaults.colors(
                containerColor = TallyColors.ground,
                contentColor = TallyColors.text,
                focusedContainerColor = if (showFocus) TallyColors.groundRaised else TallyColors.ground,
                focusedContentColor = TallyColors.text,
                pressedContainerColor = TallyColors.groundRaised,
                pressedContentColor = TallyColors.text,
            ),
        border =
            ClickableSurfaceDefaults.border(
                border = idle,
                focusedBorder =
                    if (showFocus) {
                        Border(
                            BorderStroke(TallyDimens.focusBorder, TallyColors.accent),
                            shape = RectangleShape,
                        )
                    } else {
                        idle
                    },
                pressedBorder = Border(BorderStroke(TallyDimens.focusBorder, TallyColors.accent), shape = RectangleShape),
            ),
        glow = ClickableSurfaceDefaults.glow(Glow.None, Glow.None, Glow.None),
        modifier = modifier.fillMaxWidth().tallyClickable(onClick = onClick, onLongClick = onLongClick),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            IndicatorSquare(color = indicator, size = 10.dp)
            Column(Modifier.weight(1f)) {
                Text(text = title, style = TallyType.body, color = TallyColors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    text = meta.tallyUppercase(),
                    style = TallyType.label,
                    color = metaColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalAlignment = Alignment.CenterVertically, content = hints)
        }
    }
}
