// Modified for Tally (https://github.com/Scdouglas1999/Tally), a fork of Wholphin
// (https://github.com/damontecres/Wholphin), from September 2026. Changes are marked TALLY: begin/end;
// each change and its date is in the git history. See NOTICE.md.
package com.github.damontecres.wholphin.services

import androidx.compose.runtime.mutableStateListOf
import androidx.navigation3.runtime.NavKey
import com.github.damontecres.wholphin.data.CurrentUser
import com.github.damontecres.wholphin.data.model.JellyfinServer
import kotlinx.serialization.Serializable
import org.acra.ACRA
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages navigating for setup
 */
@Singleton
class SetupNavigationManager
    @Inject
    constructor(
        private val navigationManager: NavigationManager,
    ) {
        var backStack: MutableList<SetupDestination> = mutableStateListOf(SetupDestination.Loading)

        /**
         * Go to the specified [SetupDestination]
         */
        fun navigateTo(destination: SetupDestination) {
            // TALLY: begin
            io.github.scdouglas1999.tally.ui.setup.TallySetupReturn
                .onNavigate(backStack.firstOrNull(), destination)
            // TALLY: end
            backStack[0] = destination
            log()
            if (destination !is SetupDestination.AppContent) {
                navigationManager.reloadHome()
            }
        }

        private fun log() {
            val dest = backStack.lastOrNull().toString()
            Timber.i("Current setup destination: %s", dest)
            ACRA.errorReporter.putCustomData("setupDestination", dest)
        }
    }

@Serializable
sealed interface SetupDestination : NavKey {
    @Serializable
    data object Loading : SetupDestination

    @Serializable
    data object ServerList : SetupDestination

    @Serializable
    data class UserList(
        val server: JellyfinServer,
    ) : SetupDestination

    @Serializable
    data class AppContent(
        val current: CurrentUser,
    ) : SetupDestination
}
