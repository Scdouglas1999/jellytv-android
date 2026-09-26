package io.github.scdouglas1999.tally

import com.github.damontecres.wholphin.data.CurrentUser
import com.github.damontecres.wholphin.data.ServerRepository
import com.github.damontecres.wholphin.data.model.JellyfinServer
import com.github.damontecres.wholphin.data.model.JellyfinUser
import com.github.damontecres.wholphin.services.SetupDestination
import io.github.scdouglas1999.tally.ui.setup.TallySetupReturn
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableStateFlow
import org.jellyfin.sdk.model.UUID
import org.junit.After
import org.junit.Assert
import org.junit.Test

/** BACK out of the user and server lists opened from the app, and the saved session kept meanwhile. */
class SetupReturnTest {
    private val serverId = UUID.randomUUID()
    private val server = JellyfinServer(serverId, "test server", "http://localhost:8096", "10.10.6")
    private val user = JellyfinUser(rowId = 1, id = UUID.randomUUID(), serverId = serverId, name = "admin", accessToken = "t")
    private val session = CurrentUser(server, user)
    private val current = MutableStateFlow<CurrentUser?>(session)
    private val repository = mockk<ServerRepository> { every { current } returns this@SetupReturnTest.current }

    @After
    fun tearDown() {
        TallySetupReturn.onNavigate(null, SetupDestination.Loading)
    }

    @Test
    fun `lists opened from the app remember the session`() {
        TallySetupReturn.onNavigate(SetupDestination.AppContent(session), SetupDestination.UserList(server))
        Assert.assertTrue(TallySetupReturn.keepSavedSession())
        Assert.assertEquals(session, TallySetupReturn.returnSession(repository))
        // on to the server list and another server's users: still the way back
        TallySetupReturn.onNavigate(SetupDestination.UserList(server), SetupDestination.ServerList)
        Assert.assertEquals(session, TallySetupReturn.returnSession(repository))
    }

    @Test
    fun `back in the app or a startup forgets it`() {
        TallySetupReturn.onNavigate(SetupDestination.AppContent(session), SetupDestination.UserList(server))
        TallySetupReturn.onNavigate(SetupDestination.UserList(server), SetupDestination.AppContent(session))
        Assert.assertFalse(TallySetupReturn.keepSavedSession())
        Assert.assertNull(TallySetupReturn.returnSession(repository))
    }

    @Test
    fun `lists at startup have no way back`() {
        TallySetupReturn.onNavigate(SetupDestination.Loading, SetupDestination.UserList(server))
        Assert.assertFalse(TallySetupReturn.keepSavedSession())
        Assert.assertNull(TallySetupReturn.returnSession(repository))
    }

    @Test
    fun `a removed session is no way back`() {
        TallySetupReturn.onNavigate(SetupDestination.AppContent(session), SetupDestination.UserList(server))
        current.value = null
        Assert.assertNull(TallySetupReturn.returnSession(repository))
    }
}
