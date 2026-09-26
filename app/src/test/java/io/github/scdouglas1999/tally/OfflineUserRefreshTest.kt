package io.github.scdouglas1999.tally

import android.content.Context
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
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.jellyfin.sdk.Jellyfin
import org.jellyfin.sdk.api.client.ApiClient
import org.jellyfin.sdk.api.client.Response
import org.jellyfin.sdk.api.client.extensions.userApi
import org.jellyfin.sdk.api.operations.UserApi
import org.jellyfin.sdk.model.ClientInfo
import org.jellyfin.sdk.model.DeviceInfo
import org.jellyfin.sdk.model.UUID
import org.jellyfin.sdk.model.api.UserDto
import org.junit.After
import org.junit.Assert
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** After an offline start the user details are fetched once the server answers (`tallyRefreshUserDto`). */
class OfflineUserRefreshTest {
    private val testDispatcher = StandardTestDispatcher()

    @get:Rule
    val temporaryFolder: TemporaryFolder = TemporaryFolder.builder().assureDeletion().build()

    private val apiClient = mockk<ApiClient>()
    private val userApi = mockk<UserApi>()

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
        every { apiClient.userApi } returns userApi
        every { apiClient.update(any(), any(), any(), any()) } just Runs
        every { apiClient.clientInfo } returns ClientInfo("Tally test", "0.0.1")
        every { apiClient.deviceInfo } returns DeviceInfo("Tally test ID", "Tally test device")
        coEvery { userApi.getCurrentUser() } returns Response(userDto, 200, emptyMap())
    }

    @After
    fun tearDown() {
        WholphinDispatchers.reset()
    }

    private fun create() =
        ServerRepository(
            mockk<Context>(relaxed = true),
            mockk<Jellyfin>(),
            mockk<JellyfinServerDao>(),
            apiClient,
            DataStoreFactory.create(
                serializer = AppPreferencesSerializer(),
                produceFile = { temporaryFolder.newFile("prefs.pb") },
                scope = CoroutineScope(testDispatcher),
            ),
            testDispatcher,
        )

    @Test
    fun `offline start then online sets the user details`() =
        runTest(testDispatcher) {
            val repository = create()
            repository.tallyRestoreOffline(CurrentUser(server, user))
            Assert.assertNull(repository.currentUserDto)
            // upstream's refresh only replaces details it already has: after an offline start it keeps nothing
            repository.updateUserDto()
            Assert.assertNull(repository.currentUserDto)
            repository.tallyRefreshUserDto()
            Assert.assertEquals(userDto, repository.currentUserDto)
        }

    @Test
    fun `details of another user are not taken`() =
        runTest(testDispatcher) {
            coEvery { userApi.getCurrentUser() } returns Response(userDto.copy(id = UUID.randomUUID()), 200, emptyMap())
            val repository = create()
            repository.tallyRestoreOffline(CurrentUser(server, user))
            repository.tallyRefreshUserDto()
            Assert.assertNull(repository.currentUserDto)
        }
}
