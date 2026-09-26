package io.github.scdouglas1999.tally.ui.setup

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.data.model.JellyfinServer
import com.github.damontecres.wholphin.data.model.JellyfinUser
import com.github.damontecres.wholphin.services.SetupDestination
import com.github.damontecres.wholphin.ui.components.DialogItem
import com.github.damontecres.wholphin.ui.components.DialogPopup
import com.github.damontecres.wholphin.ui.isNotNullOrBlank
import com.github.damontecres.wholphin.ui.nav.Destination
import com.github.damontecres.wholphin.ui.setup.JellyfinUserAndImage
import com.github.damontecres.wholphin.ui.setup.ServerVersionSupported
import com.github.damontecres.wholphin.ui.setup.SwitchUserResult
import com.github.damontecres.wholphin.ui.setup.SwitchUserViewModel
import com.github.damontecres.wholphin.ui.toServerString
import com.github.damontecres.wholphin.util.LoadingState
import io.github.scdouglas1999.tally.media.kit.TallyButton
import io.github.scdouglas1999.tally.ui.components.LampState
import io.github.scdouglas1999.tally.ui.formfactor.LocalTallyFormFactor
import io.github.scdouglas1999.tally.ui.formfactor.TallyFormFactor
import io.github.scdouglas1999.tally.ui.settings.phone.PhoneButton
import io.github.scdouglas1999.tally.ui.setup.phone.PhoneUserSquare
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import io.github.scdouglas1999.tally.ui.theme.TallyDimens
import kotlinx.coroutines.launch

/** What the user picker shows: the list, or one sign-in step for [user] (null: a new user). */
private sealed interface UserStep {
    data object List : UserStep

    data class QuickConnect(
        val user: JellyfinUser?,
    ) : UserStep

    data class Credentials(
        val user: JellyfinUser?,
    ) : UserStep

    data class Pin(
        val user: JellyfinUser,
    ) : UserStep
}

private val TileGap = 8.dp
private val RowPad = TallyDimens.focusBorder + 1.dp

/**
 * Select User in the Tally look (seam in upstream's `SwitchUserContent`), on upstream's [SwitchUserViewModel]:
 * square user tiles and a `+` tile, Switch Server, then Quick Connect, username/password and PIN as full-screen
 * steps. Nobody signed in on this TV yet and Quick Connect on: the code opens straight away (as the upstream seam
 * does for stamped installs).
 */
@Composable
fun TallyUserPicker(
    server: JellyfinServer,
    viewModel: SwitchUserViewModel,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { viewModel.init() }
    val state by viewModel.state.collectAsState()
    val currentUser by viewModel.serverRepository.currentUserFlow.collectAsState(null)
    var step by remember(server) { mutableStateOf<UserStep>(UserStep.List) }

    // The tile that had focus, so returning from a sign-in step lands on it again (index == users.size: Add User).
    var lastFocused by remember(server) { mutableIntStateOf(0) }
    val serverName = server.name ?: server.url

    fun showSignIn(user: JellyfinUser?) {
        step = if (state.quickConnectEnabled) UserStep.QuickConnect(user) else UserStep.Credentials(user)
    }

    fun trySwitchUser(user: JellyfinUser) {
        val result = viewModel.trySwitchUser(user)
        scope.launch {
            when (val r = result.await()) {
                is SwitchUserResult.Error -> {
                    Toast.makeText(context, r.errorMessage, Toast.LENGTH_LONG).show()
                    if (r.showLogin) showSignIn(user)
                }

                SwitchUserResult.Success -> {}
            }
        }
    }

    var offeredSignIn by remember { mutableStateOf(false) }
    LaunchedEffect(state.loading, state.users.isEmpty(), state.quickConnectEnabled) {
        if (!offeredSignIn && state.loading == LoadingState.Success && state.users.isEmpty() && state.quickConnectEnabled) {
            offeredSignIn = true
            showSignIn(null)
        }
    }
    LaunchedEffect(state.switchUserState) {
        if (step == UserStep.List) {
            (state.switchUserState as? LoadingState.Error)?.let { s ->
                Toast.makeText(context, "Error: ${s.message ?: s.exception?.localizedMessage}", Toast.LENGTH_LONG).show()
            }
        }
    }

    val trouble: @Composable () -> Unit = {
        TallyTrouble(state.loginAttempts) { viewModel.navigationManager.navigateTo(Destination.Debug) }
    }

    when (val current = step) {
        UserStep.List -> {
            // Opened from the app: BACK returns to it (this server's list) or to the server list (another server's).
            val returnTo = TallySetupReturn.returnSession(viewModel.serverRepository)
            BackHandler(enabled = returnTo != null) {
                returnTo?.let {
                    viewModel.setupNavigationManager.navigateTo(
                        if (it.server.id == server.id) SetupDestination.AppContent(it) else SetupDestination.ServerList,
                    )
                }
            }
            TallySetupFrame(
                kicker = stringResource(R.string.tally_signin_kicker_user),
                subtitle = if (server.name.isNullOrBlank()) server.url else "${server.name} · ${server.url}",
                modifier = modifier,
            ) {
                when (val loading = state.loading) {
                    LoadingState.Success -> {
                        UserList(
                            users = state.users,
                            currentUser = currentUser,
                            focusIndex = lastFocused,
                            onFocusIndex = { lastFocused = it },
                            onSwitchUser = { user ->
                                when {
                                    user.accessToken == null || user.requireLogin -> showSignIn(user)
                                    user.hasPin -> step = UserStep.Pin(user)
                                    else -> trySwitchUser(user)
                                }
                            },
                            onAddUser = { showSignIn(null) },
                            onRemoveUser = viewModel::removeUser,
                            onSwitchServer = {
                                viewModel.setupNavigationManager.navigateTo(SetupDestination.ServerList)
                            },
                        )
                        VersionWarning(
                            supported = state.serverVersionSupported,
                            version = state.serverVersion,
                            modifier = Modifier.align(Alignment.BottomCenter),
                        )
                    }

                    is LoadingState.Error -> {
                        SetupError(loading, Modifier.align(Alignment.Center).padding(TallyDimens.marginHorizontal))
                    }

                    else -> {}
                }
            }
        }

        is UserStep.QuickConnect -> {
            val close = {
                viewModel.cancelQuickConnect()
                step = UserStep.List
            }
            BackHandler(onBack = close)
            LaunchedEffect(current) {
                viewModel.clearSwitchUserState()
                viewModel.resetAttempts()
                viewModel.initiateQuickConnect(server, current.user)
            }
            val status = state.quickConnectStatus
            val lamp =
                when {
                    status?.authenticated == true -> LampState.Lit
                    state.switchUserState is LoadingState.Error -> LampState.Off
                    else -> LampState.Sputtering
                }
            if (LocalTallyFormFactor.current == TallyFormFactor.PHONE) {
                // A phone: one sign-in page, the username and password with Quick Connect's code under them.
                TallySetupFrame(
                    kicker = stringResource(R.string.tally_signin_kicker_sign_in),
                    subtitle = current.user?.name,
                    modifier = modifier,
                ) {
                    TallyCredentials(
                        serverName = serverName,
                        initialUsername = current.user?.name ?: "",
                        switchUserState = state.switchUserState,
                        onPasswordChanged = { viewModel.clearSwitchUserState() },
                        onSubmit = { username, password -> viewModel.login(server, current.user, username, password) },
                        trouble = {
                            TallyQuickConnect(
                                serverName = serverName,
                                status = status,
                                switchUserState = state.switchUserState,
                                onUsePassword = {},
                                lamp = lamp,
                            )
                            trouble()
                        },
                    )
                }
                return
            }
            TallySetupFrame(
                kicker = stringResource(R.string.tally_signin_kicker_quick_connect),
                kickerLamp = lamp,
                subtitle = current.user?.name,
                modifier = modifier,
            ) {
                TallyQuickConnect(
                    serverName = serverName,
                    status = status,
                    switchUserState = state.switchUserState,
                    onUsePassword = {
                        viewModel.cancelQuickConnect()
                        viewModel.clearSwitchUserState()
                        step = UserStep.Credentials(current.user)
                    },
                    trouble = trouble,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }

        is UserStep.Credentials -> {
            val close = {
                viewModel.cancelQuickConnect()
                step = UserStep.List
            }
            BackHandler(onBack = close)
            LaunchedEffect(current) {
                viewModel.clearSwitchUserState()
            }
            TallySetupFrame(
                kicker = stringResource(R.string.tally_signin_kicker_sign_in),
                modifier = modifier,
            ) {
                TallyCredentials(
                    serverName = serverName,
                    initialUsername = current.user?.name ?: "",
                    switchUserState = state.switchUserState,
                    onPasswordChanged = { viewModel.clearSwitchUserState() },
                    onSubmit = { username, password -> viewModel.login(server, current.user, username, password) },
                    trouble = trouble,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }

        is UserStep.Pin -> {
            BackHandler { step = UserStep.List }
            TallySetupFrame(
                kicker = stringResource(R.string.tally_signin_kicker_pin),
                subtitle = current.user.name,
                modifier = modifier,
            ) {
                TallyPinEntry(
                    onTextChange = { if (it == current.user.pin) trySwitchUser(current.user) },
                    onClickServerAuth = { showSignIn(current.user) },
                    // a phone: the pad sits at the top of the step, under its title
                    modifier =
                        Modifier.align(
                            if (LocalTallyFormFactor.current == TallyFormFactor.PHONE) Alignment.TopCenter else Alignment.Center,
                        ),
                )
            }
        }
    }
}

@Composable
private fun UserList(
    users: List<JellyfinUserAndImage>,
    currentUser: JellyfinUser?,
    focusIndex: Int,
    onFocusIndex: (Int) -> Unit,
    onSwitchUser: (JellyfinUser) -> Unit,
    onAddUser: () -> Unit,
    onRemoveUser: (JellyfinUser) -> Unit,
    onSwitchServer: () -> Unit,
) {
    var showDeleteDialog by remember { mutableStateOf<JellyfinUserAndImage?>(null) }
    val focusManager = LocalFocusManager.current
    val firstFocus = remember { FocusRequester() }
    var hasFocus by remember { mutableStateOf(false) }
    val target = focusIndex.coerceIn(0, users.size)
    val phone = LocalTallyFormFactor.current == TallyFormFactor.PHONE
    LaunchedEffect(users.isEmpty()) {
        if (!phone) requestUntilFocused(firstFocus, { hasFocus }, focusManager, "tally-user-first")
    }
    if (phone) {
        PhoneUserGrid(
            users = users,
            currentUser = currentUser,
            onSwitchUser = onSwitchUser,
            onMenu = { showDeleteDialog = it },
            onAddUser = onAddUser,
            onSwitchServer = onSwitchServer,
        )
    } else {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
                modifier = Modifier.fillMaxWidth().onFocusChanged { hasFocus = it.hasFocus },
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(TileGap),
                        contentPadding = PaddingValues(horizontal = TallyDimens.marginHorizontal, vertical = RowPad),
                        modifier = Modifier.wrapContentWidth(),
                    ) {
                        itemsIndexed(users, key = { _, it -> it.user.id }) { index, user ->
                            val isCurrent = user.user.id == currentUser?.id
                            SetupTile(
                                name = user.user.name ?: user.user.id.toString(),
                                onClick = { onSwitchUser(user.user) },
                                onLongClick = { showDeleteDialog = user },
                                detail = if (isCurrent) stringResource(R.string.tally_signin_current_user) else null,
                                onFocused = { onFocusIndex(index) },
                                tileModifier = if (index == target) Modifier.focusRequester(firstFocus) else Modifier,
                            ) {
                                TileFace(
                                    initialOf = user.user.name ?: user.user.id.toString(),
                                    imageUrl = user.imageUrl?.takeIf { it.isNotNullOrBlank() },
                                )
                            }
                        }
                        item(key = "add") {
                            SetupTile(
                                name = stringResource(R.string.tally_signin_add_user),
                                muted = true,
                                onClick = onAddUser,
                                onFocused = { onFocusIndex(users.size) },
                                tileModifier = if (target == users.size) Modifier.focusRequester(firstFocus) else Modifier,
                            ) {
                                PlusFace()
                            }
                        }
                    }
                }
                TallyButton(
                    label = stringResource(R.string.tally_signin_switch_server),
                    glyph = stringResource(R.string.fa_arrow_left_arrow_right),
                    onClick = onSwitchServer,
                )
            }
        }
    }
    showDeleteDialog?.let { user ->
        DialogPopup(
            showDialog = true,
            title = user.user.name ?: user.user.id.toServerString(),
            dialogItems =
                buildList {
                    add(
                        DialogItem(stringResource(R.string.switch_user), R.string.fa_arrow_left_arrow_right) {
                            onSwitchUser(user.user)
                        },
                    )
                    if (user.known) {
                        add(
                            DialogItem(stringResource(R.string.delete), Icons.Default.Delete, Color.Red.copy(alpha = .8f)) {
                                onRemoveUser(user.user)
                            },
                        )
                    }
                },
            onDismissRequest = { showDeleteDialog = null },
            dismissOnClick = true,
            waitToLoad = true,
            properties = DialogProperties(),
        )
    }
}

@Composable
private fun VersionWarning(
    supported: ServerVersionSupported,
    version: String?,
    modifier: Modifier = Modifier,
) {
    if (supported == ServerVersionSupported.SUPPORTED) return
    val base = stringResource(R.string.server_version_not_supported)
    val unknown = stringResource(R.string.unknown)
    Text(
        text = "$base: ${if (version.isNotNullOrBlank()) version else unknown}",
        style = setupBody,
        color = TallyColors.liveText,
        textAlign = TextAlign.Center,
        maxLines = 2,
        modifier =
            modifier
                .fillMaxWidth()
                .padding(horizontal = TallyDimens.marginHorizontal, vertical = TallyDimens.marginVertical),
    )
}

/** The phone's user picker: a 3-column grid of user squares and Add User, then SWITCH SERVER full width. */
@Composable
private fun PhoneUserGrid(
    users: List<JellyfinUserAndImage>,
    currentUser: JellyfinUser?,
    onSwitchUser: (JellyfinUser) -> Unit,
    onMenu: (JellyfinUserAndImage) -> Unit,
    onAddUser: () -> Unit,
    onSwitchServer: () -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        horizontalArrangement = Arrangement.spacedBy(PhoneDimens.gutter),
        verticalArrangement = Arrangement.spacedBy(PhoneDimens.gutter),
        contentPadding = PaddingValues(start = PhoneDimens.margin, end = PhoneDimens.margin, top = 8.dp, bottom = 96.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(users, key = { it.user.id }) { user ->
            PhoneUserSquare(
                name = user.user.name ?: user.user.id.toString(),
                detail = if (user.user.id == currentUser?.id) stringResource(R.string.tally_signin_current_user) else null,
                onClick = { onSwitchUser(user.user) },
                onLongClick = { onMenu(user) },
            ) {
                TileFace(
                    initialOf = user.user.name ?: user.user.id.toString(),
                    imageUrl = user.imageUrl?.takeIf { it.isNotNullOrBlank() },
                )
            }
        }
        item(key = "add") {
            PhoneUserSquare(name = stringResource(R.string.tally_signin_add_user), muted = true, onClick = onAddUser) {
                PlusFace()
            }
        }
        item(key = "switch-server", span = { GridItemSpan(maxLineSpan) }) {
            PhoneButton(
                label = stringResource(R.string.tally_signin_switch_server),
                onClick = onSwitchServer,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
        }
    }
}
