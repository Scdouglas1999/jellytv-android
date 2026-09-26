package io.github.scdouglas1999.tally.dvr

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.services.NavigationManager
import com.github.damontecres.wholphin.ui.launchIO
import com.github.damontecres.wholphin.ui.nav.Destination
import dagger.hilt.android.lifecycle.HiltViewModel
import io.github.scdouglas1999.tally.api.TallyGame
import io.github.scdouglas1999.tally.api.TallyTeam
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.extensions.userLibraryApi
import org.jellyfin.sdk.model.serializer.toUUIDOrNull
import timber.log.Timber
import javax.inject.Inject

/** A one-shot line for a toast: one of the app's strings, or the server's own words. */
sealed interface DvrNotice {
    data class Res(
        @param:StringRes val id: Int,
    ) : DvrNotice

    data class Text(
        val text: String,
    ) : DvrNotice
}

/**
 * The DVR for any screen that shows it (the game menu and sheet, the Recordings tab, the live player): the shared
 * [TallyDvrRepository] state and every action, each followed by a refresh of the list and the board. Failures come
 * back as [notices] with the server's reason.
 */
@HiltViewModel
class DvrViewModel
    @Inject
    constructor(
        private val repository: TallyDvrRepository,
        private val navigationManager: NavigationManager,
        private val api: ApiClient,
    ) : ViewModel() {
        val enabled: StateFlow<Boolean> = repository.enabled
        val list: StateFlow<DvrList?> = repository.list
        val storage: StateFlow<DvrStorage?> = repository.storage
        val estimates: StateFlow<Map<String, DvrStorage>> = repository.estimates
        val error: StateFlow<String?> = repository.error

        private val _notices = MutableSharedFlow<DvrNotice>(extraBufferCapacity = 8)
        val notices: SharedFlow<DvrNotice> = _notices.asSharedFlow()

        private val _libraryNotice = MutableStateFlow<LibraryAvailability?>(null)

        /** A finished recording was chosen that has no library item yet: why ([RecordingsTabEffects] shows it). */
        val libraryNotice: StateFlow<LibraryAvailability?> = _libraryNotice.asStateFlow()

        private var polling = false

        fun refresh() {
            viewModelScope.launchIO { repository.refresh() }
        }

        fun loadEstimate(gameId: String) {
            viewModelScope.launchIO { repository.loadEstimate(gameId) }
        }

        /** Keeps the list fresh while the calling screen is shown (the Recordings tab). */
        fun setPolling(on: Boolean) {
            if (on == polling) return
            polling = on
            if (on) repository.startPolling() else repository.stopPolling()
        }

        override fun onCleared() {
            if (polling) repository.stopPolling()
            super.onCleared()
        }

        fun record(game: TallyGame) = act { repository.recordGame(game.id) }

        /** Every [team] game in [game]'s league, keeping the last [keepLast] (0 = all). Also changes an existing rule. */
        fun recordTeam(
            game: TallyGame,
            team: TallyTeam,
            keepLast: Int,
        ) = act { repository.recordTeam(team.id, game.league, keepLast) }

        /** Changes a rule's keep-last (the server updates the rule it already has for the team). */
        fun changeKeepLast(
            rule: DvrRule,
            league: String,
            keepLast: Int,
        ) {
            val teamId = rule.teamId ?: return
            act { repository.recordTeam(teamId, league.ifBlank { "*" }, keepLast) }
        }

        /** Cancels a job that has not started, or stops a recording (keeping what was recorded). */
        fun cancel(jobId: String) = act { repository.cancelJob(jobId) }

        /** Deletes a finished recording. 409: someone is watching it. */
        fun deleteRecording(jobId: String) = act(conflict = R.string.tally_dvr_error_watching) { repository.deleteRecording(jobId) }

        /** Removes a failed (or canceled) job from the list. */
        fun dismiss(jobId: String) = act { repository.deleteRecording(jobId) }

        fun deleteRule(ruleId: String) = act { repository.deleteRule(ruleId) }

        /**
         * Plays everything recorded so far of a game that is being recorded, from its first minute. From the live
         * player it takes the live player's place ([replaceCurrent]), as switching games does.
         */
        fun watchFromStart(
            jobId: String,
            startOverPath: String,
            title: String,
            replaceCurrent: Boolean = false,
        ) {
            if (replaceCurrent) navigationManager.backStack.removeLastOrNull()
            navigationManager.navigateTo(Destination.TallyStartOver(jobId = jobId, path = startOverPath, title = title))
        }

        /** Plays a finished recording (a library item), from where this user stopped watching it. */
        fun playRecording(itemId: String) {
            val id = itemId.toUUIDOrNull() ?: return
            viewModelScope.launchIO {
                val positionMs =
                    try {
                        api.userLibraryApi
                            .getItem(itemId = id)
                            .content.userData
                            ?.playbackPositionTicks
                            ?.div(TICKS_PER_MS) ?: 0L
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Timber.w(e, "Tally DVR: no resume position for %s", itemId)
                        0L
                    }
                withContext(Dispatchers.Main) {
                    navigationManager.navigateTo(Destination.Playback(itemId = id, positionMs = positionMs))
                }
            }
        }

        /** Plays [job]'s recording, or says why it cannot be played yet (no library item: [libraryNotice]). */
        fun playFinished(job: DvrJob) {
            val itemId = job.itemId
            if (itemId == null) _libraryNotice.value = job.libraryAvailability else playRecording(itemId)
        }

        fun dismissLibraryNotice() {
            _libraryNotice.value = null
        }

        fun absoluteUrl(path: String): String? = repository.absoluteUrl(path)

        private fun act(
            @StringRes conflict: Int? = null,
            block: suspend () -> Unit,
        ) {
            viewModelScope.launchIO {
                try {
                    block()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: DvrException) {
                    Timber.w(e, "Tally DVR: change refused (%d)", e.code)
                    val notice =
                        when {
                            e.code == HTTP_CONFLICT && conflict != null -> DvrNotice.Res(conflict)
                            e.code == 0 -> DvrNotice.Res(R.string.tally_dvr_error_unreachable)
                            e.serverMessage != null -> DvrNotice.Text(e.serverMessage)
                            else -> DvrNotice.Res(R.string.tally_dvr_error_generic)
                        }
                    _notices.emit(notice)
                }
            }
        }

        private companion object {
            const val HTTP_CONFLICT = 409
            const val TICKS_PER_MS = 10_000L
        }
    }
