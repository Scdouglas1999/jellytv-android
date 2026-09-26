package io.github.scdouglas1999.tally

import android.content.Context
import android.content.SharedPreferences
import androidx.datastore.core.DataStoreFactory
import com.github.damontecres.wholphin.data.CurrentUser
import com.github.damontecres.wholphin.data.JellyfinServerDao
import com.github.damontecres.wholphin.data.ServerRepository
import com.github.damontecres.wholphin.data.model.JellyfinServer
import com.github.damontecres.wholphin.data.model.JellyfinUser
import com.github.damontecres.wholphin.preferences.AppPreferencesSerializer
import com.github.damontecres.wholphin.util.WholphinDispatchers
import com.github.damontecres.wholphin.util.configure
import com.github.damontecres.wholphin.util.reset
import io.mockk.Runs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.jellyfin.sdk.Jellyfin
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.Response
import org.jellyfin.sdk.api.client.extensions.systemApi
import org.jellyfin.sdk.api.client.extensions.userApi
import org.jellyfin.sdk.api.operations.SystemApi
import org.jellyfin.sdk.api.operations.UserApi
import org.jellyfin.sdk.model.ClientInfo
import org.jellyfin.sdk.model.DeviceInfo
import org.jellyfin.sdk.model.UUID
import org.jellyfin.sdk.model.api.PublicSystemInfo
import org.jellyfin.sdk.model.api.UserDto
import org.junit.After
import org.junit.Assert
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * After an offline start the session is completed once the server answers (`tallyCompleteOfflineSession`): the user
 * details are fetched and the saved user written again (what reloads home rows and libraries), as a sign-in does.
 */
class OfflineUserRefreshTest {
    private val testDispatcher = StandardTestDispatcher()

    @get:Rule
    val temporaryFolder: TemporaryFolder = TemporaryFolder.builder().assureDeletion().build()

    private val context = mockk<Context>(relaxed = true)
    private val apiClient = mockk<ApiClient>()
    private val userApi = mockk<UserApi>()
    private val systemApi = mockk<SystemApi>()
    private val serverDao = mockk<JellyfinServerDao>()

    private val serverId = UUID.randomUUID()
    private val userId = UUID.randomUUID()
    private val server = JellyfinServer(serverId, "test server", "http://localhost:8096", "10.10.6")
    private val user = JellyfinUser(rowId = 1, id = userId, serverId = serverId, name = "admin", accessToken = "token")
    private val userDto =
        UserDto(
            id = userId,
            name = "admin",
            hasPassword = true,
            hasConfiguredPassword = true,
            hasConfiguredEasyPassword = false,
        )

    @Before
    fun setup() {
        WholphinDispatchers.configure(testDispatcher)
        every { context.getSharedPreferences(any(), any()) } returns mockk<SharedPreferences>(relaxed = true)
        every { apiClient.userApi } returns userApi
        every { apiClient.systemApi } returns systemApi
        every { apiClient.update(any(), any(), any(), any()) } just Runs
        every { apiClient.clientInfo } returns ClientInfo("Tally test", "0.0.1")
        every { apiClient.deviceInfo } returns DeviceInfo("Tally test ID", "Tally test device")
        coEvery { userApi.getCurrentUser() } returns Response(userDto, 200, emptyMap())
        coEvery { systemApi.getPublicSystemInfo() } returns
            Response(PublicSystemInfo(id = serverId.toString(), serverName = "test server", version = "10.10.6"), 200, emptyMap())
        every { serverDao.addOrUpdateServer(any()) } just Runs
        every { serverDao.addOrUpdateUser(any()) } answers { firstArg() }
    }

    @After
    fun tearDown() {
        WholphinDispatchers.reset()
    }

    private fun create() =
        ServerRepository(
            context,
            mockk<Jellyfin>(),
            serverDao,
            apiClient,
            DataStoreFactory.create(
                serializer = AppPreferencesSerializer(),
                produceFile = { temporaryFolder.newFile("prefs.pb") },
                scope = CoroutineScope(testDispatcher),
            ),
            testDispatcher,
        )

    @Test
    fun `offline start then online completes the session`() =
        runTest(testDispatcher) {
            val repository = create()
            repository.tallyRestoreOffline(CurrentUser(server, user))
            Assert.assertNull(repository.currentUserDto)
            // upstream's refresh only replaces details it already has: after an offline start it keeps nothing
            repository.updateUserDto()
            Assert.assertNull(repository.currentUserDto)
            repository.tallyCompleteOfflineSession()
            Assert.assertEquals(userDto, repository.currentUserDto)
            Assert.assertEquals(userId, repository.currentUser?.id)
            // the saved user is written again: the user flow the home settings follow emits
            verify { serverDao.addOrUpdateUser(match { it.id == userId }) }
        }

    @Test
    fun `nothing when the details are known`() =
        runTest(testDispatcher) {
            val repository = create()
            repository.tallyRestoreOffline(CurrentUser(server, user))
            repository.tallyCompleteOfflineSession()
            repository.tallyCompleteOfflineSession()
            coVerify(exactly = 1) { userApi.getCurrentUser() }
        }

    @Test
    fun `nothing without a session`() =
        runTest(testDispatcher) {
            val repository = create()
            repository.tallyCompleteOfflineSession()
            Assert.assertNull(repository.currentUserDto)
            coVerify(exactly = 0) { userApi.getCurrentUser() }
        }
}
