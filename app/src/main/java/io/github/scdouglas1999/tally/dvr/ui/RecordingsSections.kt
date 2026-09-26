package io.github.scdouglas1999.tally.dvr.ui

import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.ui.showToast
import io.github.scdouglas1999.tally.dvr.DvrFormat
import io.github.scdouglas1999.tally.dvr.DvrJob
import io.github.scdouglas1999.tally.dvr.DvrList
import io.github.scdouglas1999.tally.dvr.DvrNotice
import io.github.scdouglas1999.tally.dvr.DvrRule
import io.github.scdouglas1999.tally.dvr.DvrState
import io.github.scdouglas1999.tally.dvr.DvrStorage
import io.github.scdouglas1999.tally.dvr.DvrViewModel
import io.github.scdouglas1999.tally.dvr.keepLastText
import io.github.scdouglas1999.tally.dvr.recordingStateText
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * The Recordings tab's content, the same on a TV and a phone: RECORDING NOW (recording, and finishing into a file),
 * SCHEDULED (waiting and scheduled, from team rules too), RECORDED (finished recordings), FAILED, and the TEAM RULES.
 * Canceled jobs recorded nothing and are left out.
 */
data class RecordingsSections(
    val recordingNow: List<DvrJob>,
    val scheduled: List<DvrJob>,
    val recorded: List<DvrJob>,
    val failed: List<DvrJob>,
    val rules: List<DvrRule>,
) {
    val isEmpty: Boolean
        get() = recordingNow.isEmpty() && scheduled.isEmpty() && recorded.isEmpty() && failed.isEmpty() && rules.isEmpty()

    /** The keys of the focusable entries (job and rule ids), top to bottom, as the TV list draws them. */
    fun focusOrder(): List<String> = (recordingNow + scheduled + recorded + failed).map { it.id } + rules.map { it.id }

    /**
     * The lazy item each entry of the TV list is drawn in: the storage line, the empty state (only when empty),
     * then each section's header and rows; RECORDED is a header and one row of cards.
     */
    fun lazyIndices(): Map<String, Int> {
        val indices = HashMap<String, Int>()
        var next = if (isEmpty) 2 else 1
        for (section in listOf(recordingNow, scheduled)) {
            if (section.isEmpty()) continue
            next++
            section.forEach { indices[it.id] = next++ }
        }
        if (recorded.isNotEmpty()) {
            next++
            recorded.forEach { indices[it.id] = next }
            next++
        }
        if (failed.isNotEmpty()) {
            next++
            failed.forEach { indices[it.id] = next++ }
        }
        if (rules.isNotEmpty()) {
            next++
            rules.forEach { indices[it.id] = next++ }
        }
        return indices
    }

    companion object {
        fun of(list: DvrList): RecordingsSections =
            RecordingsSections(
                recordingNow = list.jobs.filter { it.state == DvrState.RECORDING || it.state == DvrState.FINISHING },
                scheduled = list.jobs.filter { it.isPending }.sortedBy { it.game.start },
                recorded = list.jobs.filter { it.state == DvrState.DONE },
                failed = list.jobs.filter { it.state == DvrState.FAILED },
                rules = list.rules.filter { it.isTeam },
            )
    }
}

/** "Otters at Herons": the board's short names, as the game cards say it. */
@Composable
fun jobTitle(job: DvrJob): String =
    stringResource(R.string.tally_actions_at, job.game.away.displayName, job.game.home.displayName)
        .takeIf {
            job.game.away.displayName
                .isNotBlank() &&
                job.game.home.displayName
                    .isNotBlank()
        }
        ?: job.title

/** The storage line at the top: "1.2 TB free on the server · 14 GB used by recordings". */
@Composable
fun storageLine(storage: DvrStorage?): String? {
    storage ?: return null
    val free = storage.freeBytes?.let { stringResource(R.string.tally_dvr_free_on_server, DvrFormat.size(it)) }
    val used = stringResource(R.string.tally_dvr_used_by_recordings, DvrFormat.size(storage.usedBytes))
    return listOfNotNull(free, used).joinToString(" · ")
}

/** Ticks once a second while [active], for the running times of recordings in progress. */
@Composable
fun rememberSecondTick(active: Boolean): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(active) {
        while (active) {
            now = Instant.now()
            delay(1_000L)
        }
    }
    return now
}

/** A recording in progress: "MLB · 42:10 · 1.3 GB" (finishing: "MLB · FINISHING THE RECORDING"). */
@Composable
fun recordingNowMeta(
    job: DvrJob,
    now: Instant,
): String {
    val parts = mutableListOf(job.game.league)
    if (job.state == DvrState.FINISHING) {
        parts += stringResource(R.string.tally_dvr_state_finishing)
    } else {
        DvrFormat.instant(job.startedAt)?.let { parts += DvrFormat.elapsed(it, now) }
        parts += DvrFormat.size(job.bytes)
    }
    return parts.filter { it.isNotBlank() }.joinToString(" · ")
}

/** A scheduled job: "MLB · TODAY 7:05 PM · EVERY OTTERS GAME" (or "WAITING FOR A STREAM" once it is due). */
@Composable
fun scheduledMeta(
    job: DvrJob,
    rules: List<DvrRule>,
): String {
    val parts = mutableListOf(job.game.league)
    if (job.state == DvrState.WAITING) {
        parts +=
            recordingStateText(
                io.github.scdouglas1999.tally.dvr
                    .GameRecordingView(job.state, job.id, reason = job.reason),
            )
    } else {
        DvrFormat.instant(job.game.start)?.let { parts += DvrFormat.dayAndTime(it) }
    }
    rules.firstOrNull { it.id == job.ruleId && it.isTeam }?.let { parts += it.title }
    return parts.filter { it.isNotBlank() }.joinToString(" · ")
}

/** A finished recording's card line: "MLB · SEP 24 · 2h 58m". */
fun recordedMeta(job: DvrJob): String =
    listOfNotNull(
        job.game.league.takeIf { it.isNotBlank() },
        DvrFormat.instant(job.game.start)?.let { DvrFormat.date(it) },
        job.seconds.takeIf { it > 0 }?.let { DvrFormat.length(it) },
    ).joinToString(" · ")

/** A team rule: "MLB · KEEP THE LAST 5" (any league: "ALL LEAGUES · KEEP ALL"). */
@Composable
fun ruleMeta(
    rule: DvrRule,
    list: DvrList,
): String {
    val league =
        list.jobs
            .firstOrNull { it.game.leaguePath.equals(rule.leaguePath, ignoreCase = true) }
            ?.game
            ?.league
            ?: rule.leaguePath
                .substringAfterLast('/')
                .uppercase()
                .ifBlank { stringResource(R.string.tally_dvr_all_leagues) }
    return listOf(league, keepLastText(rule.keepLast)).joinToString(" · ")
}

/** The league a rule is limited to, as the POST that changes it takes it (the path, or "*" for any league). */
fun DvrRule.leagueForChange(): String = leaguePath.ifBlank { "*" }

/** The library image of a finished recording: its 16:9 thumb (matchup art the server drew for it). */
fun recordingImageUrl(
    viewModel: DvrViewModel,
    job: DvrJob,
): String? = job.itemId?.let { viewModel.absoluteUrl("/Items/$it/Images/Thumb?maxWidth=640") }

/**
 * Hooks a Recordings tab to the DVR: keeps the list fresh while it is shown and shows the server's refusals as toasts.
 */
@Composable
fun RecordingsTabEffects(viewModel: DvrViewModel) {
    val context = LocalContext.current
    DisposableEffect(viewModel) {
        viewModel.setPolling(true)
        onDispose { viewModel.setPolling(false) }
    }
    val libraryNotice by viewModel.libraryNotice.collectAsState()
    libraryNotice?.let { RecordingLibraryNotice(it, onDismiss = viewModel::dismissLibraryNotice) }
    LaunchedEffect(viewModel) {
        viewModel.notices.collect { notice ->
            val text =
                when (notice) {
                    is DvrNotice.Res -> context.getString(notice.id)
                    is DvrNotice.Text -> notice.text
                }
            showToast(context, text, Toast.LENGTH_LONG)
        }
    }
}

/**
 * Plays a finished recording, or says why it cannot be played yet (still being added to the library, or no library
 * for recordings on the server): the notice [RecordingsTabEffects] shows.
 */
@Suppress("UNUSED_PARAMETER")
fun playRecorded(
    viewModel: DvrViewModel,
    job: DvrJob,
    context: android.content.Context,
) = viewModel.playFinished(job)
