package io.github.scdouglas1999.tally.dvr

import io.github.scdouglas1999.tally.api.TallyGame
import io.github.scdouglas1999.tally.api.TallyTeam
import kotlinx.serialization.Serializable

/*
 * The server DVR's client API (`/JellyTV/Client/v1/recordings…`, plugin feature `dvr`), decoded with TallyJson
 * (lenient: unknown keys ignored, missing keys take the defaults). Nothing here ever carries a score.
 */

/** `GET /JellyTV/Client/v1/recordings`: every rule and job on the server, and whether this user may change them. */
@Serializable
data class DvrList(
    /** The Jellyfin "manage recordings" permission (admins always have it). Without it every action is absent. */
    val canManage: Boolean = false,
    val reason: String? = null,
    val rules: List<DvrRule> = emptyList(),
    /** Recording, finishing, waiting, scheduled first; then the finished ones, newest first. */
    val jobs: List<DvrJob> = emptyList(),
)

@Serializable
data class DvrRule(
    val id: String = "",
    /** game | team */
    val kind: String = "",
    val title: String = "",
    /** Game rules: the game's league; team rules: the league it is limited to, empty = any league. */
    val leaguePath: String = "",
    val gameId: String? = null,
    val teamId: String? = null,
    val teamName: String? = null,
    /** Team rules: keep the last N recorded games, 0 = all. */
    val keepLast: Int = 0,
    val createdByName: String = "",
) {
    val isTeam: Boolean get() = kind == KIND_TEAM

    companion object {
        const val KIND_TEAM = "team"
    }
}

@Serializable
data class DvrTeam(
    val id: String = "",
    val abbr: String = "",
    val name: String = "",
    val shortName: String = "",
    val logo: String = "",
) {
    /** The name a line uses: the short name ("Otters"), else the abbreviation, else the full name. */
    val displayName: String get() = shortName.ifBlank { abbr.ifBlank { name } }

    fun toTeam(): TallyTeam = TallyTeam(id = id, abbr = abbr, name = name, shortName = shortName, logo = logo)
}

@Serializable
data class DvrJobGame(
    val id: String = "",
    val league: String = "",
    val leaguePath: String = "",
    /** ISO-8601 */
    val start: String = "",
    val away: DvrTeam = DvrTeam(),
    val home: DvrTeam = DvrTeam(),
)

@Serializable
data class DvrJob(
    val id: String = "",
    val ruleId: String = "",
    val state: String = "",
    val reason: String? = null,
    /** canceled | disk | maxLength | postponed | restart, when a recording stopped before the game's end. */
    val stopReason: String? = null,
    /** "Away at Home" */
    val title: String = "",
    val game: DvrJobGame = DvrJobGame(),
    val createdAt: String? = null,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val channelName: String? = null,
    /** Bytes recorded so far. */
    val bytes: Long = 0,
    /** Seconds recorded so far (the length of a finished recording). */
    val seconds: Double = 0.0,
    val fileBytes: Long = 0,
    val itemId: String? = null,
    /** Root-relative, signed start-over playlist, while recording. */
    val startOverPath: String? = null,
    /**
     * Whether the recording can be played from a library yet: `ready` ([itemId] is set), `adding` (a library covers
     * the file, Jellyfin has not picked it up yet) or `noLibrary` (no library covers the recordings folder). Older
     * plugins leave it out: see [libraryAvailability].
     */
    val libraryState: String? = null,
) {
    val isRecording: Boolean get() = state == DvrState.RECORDING
    val isPending: Boolean get() = state == DvrState.SCHEDULED || state == DvrState.WAITING
    val isFinal: Boolean get() = state == DvrState.DONE || state == DvrState.FAILED || state == DvrState.CANCELED
}

/** `GET /JellyTV/Client/v1/recordings/storage[?gameId=]`. */
@Serializable
data class DvrStorage(
    val freeBytes: Long? = null,
    val totalBytes: Long? = null,
    val usedBytes: Long = 0,
    val reserveBytes: Long = 0,
    val estimate: DvrEstimate? = null,
)

@Serializable
data class DvrEstimate(
    val gameId: String = "",
    val bytes: Long = 0,
    val fits: Boolean = true,
    /** Why it won't fit ("Not enough space: needs ~9 GB, 4 GB free"), from the server. */
    val message: String? = null,
)

/** Why a finished recording cannot be played yet, or [READY]: the job's `libraryState`. */
enum class LibraryAvailability {
    READY,
    ADDING,
    NO_LIBRARY,
}

/**
 * The job's [DvrJob.libraryState], with the rules for plugins that do not send it: a recording with an `itemId` is
 * ready; one without is still being added. An unknown value counts the same way.
 */
val DvrJob.libraryAvailability: LibraryAvailability
    get() =
        when {
            itemId != null -> LibraryAvailability.READY
            libraryState == "noLibrary" -> LibraryAvailability.NO_LIBRARY
            else -> LibraryAvailability.ADDING
        }

/** The job states, as the server names them. */
object DvrState {
    const val SCHEDULED = "scheduled"
    const val WAITING = "waiting"
    const val RECORDING = "recording"
    const val FINISHING = "finishing"
    const val DONE = "done"
    const val FAILED = "failed"
    const val CANCELED = "canceled"
}

/**
 * What the app shows for one game's recording: the list's job when the list has one (it knows when the recording
 * started), else the board's [TallyGame.recording].
 */
data class GameRecordingView(
    val state: String,
    val jobId: String,
    val startedAt: String? = null,
    val startOverPath: String? = null,
    val itemId: String? = null,
    val reason: String? = null,
    val seconds: Double = 0.0,
) {
    val isRecording: Boolean get() = state == DvrState.RECORDING
    val isPending: Boolean get() = state == DvrState.SCHEDULED || state == DvrState.WAITING
    val isFailed: Boolean get() = state == DvrState.FAILED
    val isFinal: Boolean get() = state == DvrState.DONE || state == DvrState.FAILED || state == DvrState.CANCELED

    /** A game can be recorded (again) when it has no job, or only one that ended without recording it. */
    val allowsNewRecording: Boolean get() = state == DvrState.FAILED || state == DvrState.CANCELED
}

/** The most relevant job of [gameId]: one still running first, then a finished recording, then the newest. */
fun List<DvrJob>.forGame(gameId: String): DvrJob? =
    filter { it.game.id == gameId }
        .sortedWith(
            compareBy<DvrJob> { if (it.isFinal) 1 else 0 }
                .thenBy { if (it.state == DvrState.DONE) 0 else 1 }
                .thenByDescending { it.createdAt ?: "" },
        ).firstOrNull()

/** [game]'s recording from the list when it has the game's job, else from the board. */
fun recordingView(
    game: TallyGame,
    list: DvrList?,
): GameRecordingView? {
    val job = list?.jobs?.forGame(game.id)
    if (job != null) {
        return GameRecordingView(
            state = job.state,
            jobId = job.id,
            startedAt = job.startedAt,
            startOverPath = job.startOverPath ?: game.recording?.startOverPath?.takeIf { job.isRecording },
            itemId = job.itemId,
            reason = job.reason,
            seconds = job.seconds,
        )
    }
    val board = game.recording ?: return null
    return GameRecordingView(
        state = board.state,
        jobId = board.jobId,
        startOverPath = board.startOverPath,
        itemId = board.itemId,
        reason = board.reason,
    )
}

/**
 * No spoilers: a finished game that has (or is making) a recording keeps its score and result out of sight. The
 * board's own field is enough, so every card can decide without the recordings list.
 */
val TallyGame.hasRecordingToWatch: Boolean
    get() =
        recording?.state.let {
            it == DvrState.DONE || it == DvrState.FINISHING || it == DvrState.RECORDING
        }

val TallyGame.spoilerGuarded: Boolean get() = isFinal && hasRecordingToWatch

/**
 * The team rule that records [team]'s games in [game]'s league, if any. Rules name the league by its path
 * ("baseball/mlb") and the board by its label ("MLB"): a job of the same league tells which path that is; without
 * one, the sport the path starts with has to do (team ids are only unique within a league).
 */
fun DvrList.teamRuleFor(
    game: TallyGame,
    team: TallyTeam,
): DvrRule? {
    if (team.id.isBlank()) return null
    val knownPath =
        jobs
            .firstOrNull { it.game.league.equals(game.league, ignoreCase = true) && it.game.leaguePath.isNotBlank() }
            ?.game
            ?.leaguePath
    return rules.firstOrNull { rule ->
        rule.isTeam &&
            rule.teamId == team.id &&
            when {
                rule.leaguePath.isBlank() -> true
                knownPath != null -> rule.leaguePath.equals(knownPath, ignoreCase = true)
                else -> rule.leaguePath.substringBefore('/').equals(game.sport, ignoreCase = true)
            }
    }
}
