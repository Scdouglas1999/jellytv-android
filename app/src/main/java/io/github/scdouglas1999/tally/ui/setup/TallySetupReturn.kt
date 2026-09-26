package io.github.scdouglas1999.tally.ui.setup

import com.github.damontecres.wholphin.data.CurrentUser
import com.github.damontecres.wholphin.data.ServerRepository
import com.github.damontecres.wholphin.services.SetupDestination

/**
 * The way back out of the user and server lists when the viewer opened them from the app (the profile in the drawer,
 * the More sheet or home) and has not chosen anyone yet. Upstream's setup screens are a single page: BACK on them left
 * the app, and opening the user list had already forgotten the signed-in session, so the next launch opened the server
 * list instead of home.
 * - [onNavigate] (seam in `SetupNavigationManager.navigateTo`) remembers the session the app was showing when a setup
 *   screen replaces it, and forgets it when the app (or startup) takes over again.
 * - While it is remembered the saved session is kept ([keepSavedSession], seam in `SwitchUserViewModel.init`), so
 *   leaving the app from the lists opens home next time, as before the lists were opened.
 * - BACK on the server list goes to that session's user list, and on its user list back to the app ([returnSession]).
 */
object TallySetupReturn {
    @Volatile
    private var session: CurrentUser? = null

    /** The setup screen [from] is being replaced by [to]. */
    fun onNavigate(
        from: SetupDestination?,
        to: SetupDestination,
    ) {
        when (to) {
            is SetupDestination.AppContent, SetupDestination.Loading -> {
                session = null
            }

            is SetupDestination.UserList, SetupDestination.ServerList -> {
                if (from is SetupDestination.AppContent) session = from.current
            }
        }
    }

    /** True while the lists were opened from the app: the saved session is not cleared (the next launch opens home). */
    fun keepSavedSession(): Boolean = session != null

    /**
     * The session to go back to, while the lists were opened from it and it is still the signed-in one (not removed
     * from the list in the meantime); null otherwise (BACK leaves the app, as upstream).
     */
    fun returnSession(serverRepository: ServerRepository): CurrentUser? {
        val saved = session ?: return null
        val current = serverRepository.current.value ?: return null
        return saved.takeIf { current.server.id == it.server.id && current.user.id == it.user.id }
    }
}
