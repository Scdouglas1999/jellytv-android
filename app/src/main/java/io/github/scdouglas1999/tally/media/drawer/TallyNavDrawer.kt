package io.github.scdouglas1999.tally.media.drawer

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.animateIntOffsetAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.tv.material3.DrawerState
import androidx.tv.material3.DrawerValue
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.data.model.JellyfinServer
import com.github.damontecres.wholphin.data.model.JellyfinUser
import com.github.damontecres.wholphin.preferences.AppThemeColors
import com.github.damontecres.wholphin.preferences.UserPreferences
import com.github.damontecres.wholphin.services.SetupDestination
import com.github.damontecres.wholphin.ui.components.TimeDisplay
import com.github.damontecres.wholphin.ui.ifElse
import com.github.damontecres.wholphin.ui.nav.CollapsedDrawerItemWidth
import com.github.damontecres.wholphin.ui.nav.Destination
import com.github.damontecres.wholphin.ui.nav.DestinationContent
import com.github.damontecres.wholphin.ui.nav.DrawerAnimationStiffness
import com.github.damontecres.wholphin.ui.nav.ExpandedDrawerItemWidth
import com.github.damontecres.wholphin.ui.nav.ModalNavigationDrawer
import com.github.damontecres.wholphin.ui.nav.NavDrawerItem
import com.github.damontecres.wholphin.ui.nav.NavDrawerViewModel
import com.github.damontecres.wholphin.ui.nav.isOpen
import com.github.damontecres.wholphin.ui.preferences.PreferenceScreenOption
import com.github.damontecres.wholphin.ui.theme.LocalTheme
import com.github.damontecres.wholphin.ui.tryRequestFocus
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import io.github.scdouglas1999.tally.ui.theme.TallyDimens
import kotlinx.coroutines.launch

/** True when the Tally drawer replaces upstream's (the TALLY theme is selected). */
@Composable
fun tallyDrawerActive(): Boolean = LocalTheme.current == AppThemeColors.TALLY

/**
 * Same indexes [NavDrawerViewModel] writes. They are private on the upstream drawer, so they are repeated here.
 */
private const val HOME_INDEX = -1
private const val SEARCH_INDEX = -2
private const val NOW_PLAYING_INDEX = -3

/** No list row is the current page (a settings screen is open). Matches no index the view model writes. */
private const val NO_INDEX = Int.MIN_VALUE

/**
 * The Tally navigation drawer. Same [NavDrawerViewModel], items, actions and [ModalNavigationDrawer] as upstream,
 * drawn in the Tally language. Live TV is hidden while the Sports section is in the drawer; original indexes are kept.
 */
@Composable
fun TallyNavDrawer(
    destination: Destination,
    preferences: UserPreferences,
    user: JellyfinUser,
    server: JellyfinServer,
    drawerState: DrawerState,
    navDrawerListState: LazyListState,
    onClearBackdrop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val viewModel: NavDrawerViewModel =
        hiltViewModel(
            LocalView.current.findViewTreeViewModelStoreOwner()!!,
            key = "${server.id}_${user.id}",
        )
    LaunchedEffect(Unit) { viewModel.updateSelectedIndex() }
    val context = LocalContext.current
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }

    BackHandler(enabled = (drawerState.currentValue == DrawerValue.Closed && destination is Destination.Home)) {
        drawerState.setValue(DrawerValue.Open)
        focusRequester.requestFocus()
    }
    val serviceState by viewModel.serviceState.collectAsState()
    val state by viewModel.state.collectAsState()
    val moreExpanded = state.moreExpanded
    // On a settings screen the pinned Settings row is the current page. The view model's index still names the page
    // settings were opened from (Settings is not one of its items), so no list row is marked meanwhile.
    val onSettings = destination is Destination.Settings
    val selectedIndex = if (onSettings) NO_INDEX else state.selectedIndex

    BackHandler(enabled = moreExpanded && drawerState.currentValue == DrawerValue.Open) {
        viewModel.setShowMore(false)
    }

    val closedDrawerWidth = CollapsedDrawerItemWidth
    val openDrawerWidth = ExpandedDrawerItemWidth
    val offset by animateIntOffsetAsState(
        targetValue =
            IntOffset(
                x =
                    with(density) {
                        if (drawerState.isOpen) (openDrawerWidth - closedDrawerWidth).roundToPx() else 0
                    },
                y = 0,
            ),
        animationSpec =
            spring(
                stiffness = DrawerAnimationStiffness,
                visibilityThreshold = IntOffset.VisibilityThreshold,
            ),
    )
    val drawerWidth =
        with(density) {
            closedDrawerWidth + offset.x.toDp()
        }

    ModalNavigationDrawer(
        modifier = modifier,
        drawerState = drawerState,
        drawerContent = { drawerValue ->
            val isOpen = drawerValue.isOpen
            val searchFocusRequester = remember { FocusRequester() }
            val entry = remember { ListEntryTracker() }
            // the last row of the list: UP from the pinned Settings row goes there (upstream's Settings is the
            // list's own last item, so UP reaches the row above it)
            val lastRowRequester = remember { FocusRequester() }
            val hideLiveTv = NavDrawerItem.Sports in serviceState.items
            val visible = indexedDrawerItems(serviceState.items, hideLiveTv)
            // Ordered by how much people use them (user, 2026-09-22): Movies, TV Shows, Sports first (sortedBy is
            // stable: server order within a type), then the remaining libraries, then the other app sections. Indexes stay the original ones (see indexedDrawerItems).
            val primary =
                visible
                    .filter { it.value.tallyPrimaryRank() != null }
                    .sortedBy { it.value.tallyPrimaryRank() }
            val sections = visible.filter { it.value.tallyPrimaryRank() == null && it.value.isTallyAppSection() }
            val libraries = visible.filter { it.value.tallyPrimaryRank() == null && !it.value.isTallyAppSection() }
            val moreVisible = indexedDrawerItems(serviceState.moreItems, hideLiveTv)
            val lastRowId =
                when {
                    sections.isNotEmpty() -> sections.last().value.id
                    moreVisible.isNotEmpty() && moreExpanded -> "more-" + moreVisible.last().value.id
                    moreVisible.isNotEmpty() -> "more"
                    libraries.isNotEmpty() -> libraries.last().value.id
                    primary.isNotEmpty() -> primary.last().value.id
                    else -> "home"
                }
            val lastRow = Modifier.focusRequester(lastRowRequester)
            // Rows the list has scrolled part-way out are not drawn; the current page is kept whole while collapsed.
            val rail = remember { RailViewport() }
            val whole = Modifier.wholeInRail(rail, navDrawerListState)
            val listKeys =
                buildList {
                    add("search")
                    add("home")
                    primary.forEach { add(it.value.id) }
                    if (libraries.isNotEmpty() || moreVisible.isNotEmpty()) add("libraries")
                    libraries.forEach { add(it.value.id) }
                    if (moreVisible.isNotEmpty()) add("more")
                    if (moreExpanded) moreVisible.forEach { add("more-" + it.value.id) }
                    if (sections.isNotEmpty() && (primary.isNotEmpty() || libraries.isNotEmpty() || moreVisible.isNotEmpty())) {
                        add("sections-rule")
                    }
                    sections.forEach { add(it.value.id) }
                }
            val selectedKey =
                when (selectedIndex) {
                    SEARCH_INDEX -> {
                        "search"
                    }

                    HOME_INDEX -> {
                        "home"
                    }

                    else -> {
                        (primary + libraries + sections).firstOrNull { it.index == selectedIndex }?.value?.id
                            ?: moreVisible
                                .firstOrNull { it.index + serviceState.items.size == selectedIndex }
                                ?.let { "more-" + it.value.id }
                    }
                }
            val selectedListIndex = selectedKey?.let { listKeys.indexOf(it) } ?: -1
            LaunchedEffect(isOpen, selectedListIndex) {
                if (!isOpen && selectedListIndex >= 0) keepWhole(navDrawerListState, selectedListIndex)
            }
            val userImageUrl = remember(user) { viewModel.getUserImage(user) }
            val userName = user.name ?: user.id.toString()

            BoxWithConstraints(
                modifier =
                    Modifier
                        .width(drawerWidth)
                        .fillMaxHeight()
                        .clipToBounds()
                        .background(TallyColors.ground)
                        .onFocusChanged { if (!it.hasFocus) entry.lastRegion = ListEntryTracker.NONE },
            ) {
                // The row pitch that fits every entry of the collapsed rail on the screen. Expanded More items are
                // left out of the count: opening them may scroll the open drawer, but must not resize its rows.
                val rowHeight =
                    drawerRowHeight(
                        available = maxHeight,
                        rows = listKeys.count { it != "libraries" && it != "sections-rule" && !it.startsWith("more-") } + 1,
                        libraryDivider = "libraries" in listKeys,
                        sectionsDivider = "sections-rule" in listKeys,
                        nowPlaying = serviceState.nowPlayingEnabled,
                    )
                // rows stop short of the 1dp right edge, so the edge never covers a focus border
                CompositionLocalProvider(LocalDrawerRowHeight provides rowHeight) {
                    Column(modifier = Modifier.fillMaxSize().padding(end = TallyDimens.hairline)) {
                        TallyDrawerHeader(
                            drawerOpen = isOpen,
                            userName = userName,
                            userId = user.id.toString(),
                            serverName = server.name ?: server.url,
                            imageUrl = userImageUrl,
                            onProfileClick = {
                                viewModel.navigateToSetup(SetupDestination.UserList(server))
                            },
                            modifier = Modifier.onFocusChanged { if (it.hasFocus) entry.lastRegion = ListEntryTracker.HEADER },
                        )
                        AnimatedVisibility(
                            visible = serviceState.nowPlayingEnabled,
                            enter = expandVertically(expandFrom = Alignment.Top),
                            exit = shrinkVertically(shrinkTowards = Alignment.Top),
                            modifier = Modifier.onFocusChanged { if (it.hasFocus) entry.lastRegion = ListEntryTracker.HEADER },
                        ) {
                            TallyEntry(
                                label = serviceState.nowPlayingTitle.orEmpty(),
                                glyph = TallyGlyph.Font(R.string.fa_play),
                                selected = selectedIndex == NOW_PLAYING_INDEX,
                                drawerOpen = isOpen,
                                kicker = stringResource(R.string.now_playing),
                                onClick = {
                                    viewModel.setIndex(NOW_PLAYING_INDEX)
                                    viewModel.navigationManager.navigateTo(Destination.NowPlaying)
                                },
                                focusRequester = focusRequester,
                            )
                        }
                        // the list and Settings share one focus group, so entry goes to the selected item (upstream's rule)
                        Column(
                            modifier =
                                Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .onFocusChanged {
                                        val entered = it.hasFocus && !entry.listHasFocus
                                        entry.listHasFocus = it.hasFocus
                                        if (entered) {
                                            if (!entry.viaOnEnter) {
                                                // Compose skipped onEnter (it does when the page being left has its own
                                                // focus exit handling): apply upstream's entry rule here instead
                                                val fromHeader = entry.lastRegion == ListEntryTracker.HEADER
                                                scope.launch {
                                                    if (fromHeader) {
                                                        searchFocusRequester.tryRequestFocus()
                                                    } else {
                                                        focusRequester.tryRequestFocus()
                                                    }
                                                }
                                            }
                                            entry.viaOnEnter = false
                                            entry.lastRegion = ListEntryTracker.LIST
                                        }
                                    }.focusGroup()
                                    .focusProperties {
                                        onEnter = {
                                            entry.viaOnEnter = true
                                            if (entry.stepFromSettings) {
                                                // UP from Settings: land on the row above it, no redirect
                                            } else if (requestedFocusDirection == FocusDirection.Down) {
                                                searchFocusRequester.tryRequestFocus()
                                            } else {
                                                focusRequester.tryRequestFocus()
                                            }
                                        }
                                    },
                        ) {
                            LazyColumn(
                                state = navDrawerListState,
                                // room for the focus border of the first and last rows (never clipped by the list)
                                contentPadding = PaddingValues(vertical = TallyDimens.focusBorder + 1.dp),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                modifier =
                                    Modifier
                                        .weight(1f)
                                        .fillMaxWidth()
                                        .onPlaced { rail.coordinates = it },
                            ) {
                                item(key = "search") {
                                    TallyEntry(
                                        label = stringResource(R.string.search),
                                        glyph = TallyGlyph.Font(R.string.tally_drawer_fa_search),
                                        selected = selectedIndex == SEARCH_INDEX,
                                        drawerOpen = isOpen,
                                        onClick = {
                                            viewModel.setIndex(SEARCH_INDEX)
                                            viewModel.navigationManager.navigateToFromDrawer(Destination.Search())
                                        },
                                        focusRequester = focusRequester,
                                        modifier = Modifier.focusRequester(searchFocusRequester),
                                        outerModifier = whole,
                                    )
                                }
                                item(key = "home") {
                                    TallyEntry(
                                        label = stringResource(R.string.home),
                                        glyph = TallyGlyph.Font(R.string.fa_house),
                                        selected = selectedIndex == HOME_INDEX,
                                        drawerOpen = isOpen,
                                        modifier = if (lastRowId == "home") lastRow else Modifier,
                                        outerModifier = whole,
                                        onClick = {
                                            viewModel.setIndex(HOME_INDEX)
                                            if (destination is Destination.Home) {
                                                viewModel.navigationManager.reloadHome()
                                                onClearBackdrop.invoke()
                                            } else {
                                                viewModel.navigationManager.goToHome()
                                            }
                                        },
                                        focusRequester = focusRequester,
                                    )
                                }
                                items(
                                    items = primary,
                                    key = { it.value.id },
                                ) { indexed ->
                                    DrawerItemEntry(
                                        index = indexed.index,
                                        item = indexed.value,
                                        selectedIndex = selectedIndex,
                                        drawerOpen = isOpen,
                                        context = context,
                                        focusRequester = focusRequester,
                                        onClick = viewModel::onClickDrawerItem,
                                        modifier = if (lastRowId == indexed.value.id) lastRow else Modifier,
                                        outerModifier = whole,
                                    )
                                }
                                if (libraries.isNotEmpty() || moreVisible.isNotEmpty()) {
                                    item(key = "libraries") {
                                        TallyDrawerDivider(
                                            title = stringResource(R.string.tally_drawer_libraries),
                                            drawerOpen = isOpen,
                                            modifier = whole,
                                        )
                                    }
                                }
                                items(
                                    items = libraries,
                                    key = { it.value.id },
                                ) { indexed ->
                                    DrawerItemEntry(
                                        index = indexed.index,
                                        item = indexed.value,
                                        selectedIndex = selectedIndex,
                                        drawerOpen = isOpen,
                                        context = context,
                                        focusRequester = focusRequester,
                                        onClick = viewModel::onClickDrawerItem,
                                        modifier = if (lastRowId == indexed.value.id) lastRow else Modifier,
                                        outerModifier = whole,
                                    )
                                }
                                if (moreVisible.isNotEmpty()) {
                                    val moreIndex = serviceState.items.size
                                    item(key = "more") {
                                        TallyEntry(
                                            label = NavDrawerItem.More.name(context),
                                            glyph = tallyGlyph(NavDrawerItem.More),
                                            // as upstream: More is never drawn as the current page, but it takes the
                                            // focus-entry requester when the selected index equals its own
                                            selected = false,
                                            focusTarget = selectedIndex == moreIndex,
                                            drawerOpen = isOpen,
                                            trailingGlyph =
                                                if (moreExpanded) {
                                                    R.string.fa_caret_down
                                                } else {
                                                    R.string.fa_caret_right
                                                },
                                            onClick = {
                                                viewModel.onClickDrawerItem(moreIndex, NavDrawerItem.More)
                                            },
                                            modifier = if (lastRowId == "more") lastRow else Modifier,
                                            outerModifier = whole,
                                            focusRequester = focusRequester,
                                        )
                                    }
                                }
                                if (moreExpanded) {
                                    items(
                                        items = moreVisible,
                                        key = { "more-${it.value.id}" },
                                    ) { indexed ->
                                        DrawerItemEntry(
                                            index = indexed.index + serviceState.items.size,
                                            item = indexed.value,
                                            selectedIndex = selectedIndex,
                                            drawerOpen = isOpen,
                                            context = context,
                                            focusRequester = focusRequester,
                                            onClick = viewModel::onClickDrawerItem,
                                            modifier = if (lastRowId == "more-" + indexed.value.id) lastRow else Modifier,
                                            outerModifier = whole,
                                        )
                                    }
                                }
                                if (sections.isNotEmpty() && (primary.isNotEmpty() || libraries.isNotEmpty() || moreVisible.isNotEmpty())) {
                                    item(key = "sections-rule") {
                                        TallyDrawerDivider(title = null, drawerOpen = isOpen, modifier = whole)
                                    }
                                }
                                items(
                                    items = sections,
                                    key = { it.value.id },
                                ) { indexed ->
                                    DrawerItemEntry(
                                        index = indexed.index,
                                        item = indexed.value,
                                        selectedIndex = selectedIndex,
                                        drawerOpen = isOpen,
                                        context = context,
                                        focusRequester = focusRequester,
                                        onClick = viewModel::onClickDrawerItem,
                                        modifier = if (lastRowId == indexed.value.id) lastRow else Modifier,
                                        outerModifier = whole,
                                    )
                                }
                            }
                            // Settings: upstream's footer, pinned to the bottom so it is always visible
                            TallyDrawerDivider(title = null, drawerOpen = isOpen)
                            Box(modifier = Modifier.fillMaxWidth().padding(bottom = SettingsBottomPad)) {
                                TallyEntry(
                                    label = stringResource(R.string.settings),
                                    glyph = TallyGlyph.Font(R.string.tally_drawer_fa_settings),
                                    selected = onSettings,
                                    drawerOpen = isOpen,
                                    onClick = {
                                        viewModel.navigationManager.navigateTo(
                                            Destination.Settings(PreferenceScreenOption.BASIC),
                                        )
                                    },
                                    focusRequester = focusRequester,
                                    modifier =
                                        Modifier.onPreviewKeyEvent {
                                            if (it.type == KeyEventType.KeyDown && it.key == Key.DirectionUp) {
                                                entry.stepFromSettings = true
                                                val moved = lastRowRequester.tryRequestFocus()
                                                entry.stepFromSettings = false
                                                moved
                                            } else {
                                                false
                                            }
                                        },
                                )
                            }
                        }
                    }
                }
                Box(
                    modifier =
                        Modifier
                            .align(Alignment.CenterEnd)
                            .fillMaxHeight()
                            .width(TallyDimens.hairline)
                            .background(if (isOpen) TallyColors.ruleStrong else TallyColors.rule),
                )
            }
        },
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            // The offset and inset live on a wrapper, not on the page's own modifier: Tally pages apply their
            // modifier inside TallyScale, which would shrink a dp inset by the scale (the page then overlaps the rail).
            Box(
                modifier =
                    Modifier
                        .fillMaxSize()
                        .offset { offset }
                        // no end padding (upstream has 16dp): Tally pages reach the right edge and keep their own margins
                        .padding(start = closedDrawerWidth + 8.dp)
                        // while the panel is out, nothing the page draws past its left edge may cover the panel
                        .ifElse(offset.x > 0, Modifier.clipToBounds()),
            ) {
                DestinationContent(
                    destination = destination,
                    preferences = preferences,
                    onClearBackdrop = onClearBackdrop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            if (preferences.appPreferences.interfacePreferences.showClock) {
                // The clock belongs to the page's top corner: it moves aside with the page while the panel is out,
                // instead of staying put over the page's top bar (it covered the SETTINGS tab on Sports).
                TimeDisplay(Modifier.offset { offset })
            }
        }
    }
}

@Composable
private fun DrawerItemEntry(
    index: Int,
    item: NavDrawerItem,
    selectedIndex: Int,
    drawerOpen: Boolean,
    context: Context,
    focusRequester: FocusRequester,
    onClick: (Int, NavDrawerItem) -> Unit,
    modifier: Modifier = Modifier,
    outerModifier: Modifier = Modifier,
) {
    TallyEntry(
        label = item.name(context),
        glyph = tallyGlyph(item),
        selected = selectedIndex == index,
        drawerOpen = drawerOpen,
        onClick = { onClick(index, item) },
        focusRequester = focusRequester,
        modifier = modifier,
        outerModifier = outerModifier,
    )
}

@Composable
private fun TallyEntry(
    label: String,
    glyph: TallyGlyph,
    selected: Boolean,
    drawerOpen: Boolean,
    onClick: () -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
    kicker: String? = null,
    @StringRes trailingGlyph: Int? = null,
    focusTarget: Boolean = selected,
    outerModifier: Modifier = Modifier,
) {
    TallyDrawerRow(
        label = label,
        glyph = glyph,
        selected = selected,
        drawerOpen = drawerOpen,
        onClick = onClick,
        kicker = kicker,
        trailingGlyph = if (drawerOpen) trailingGlyph else null,
        outerModifier = outerModifier,
        modifier =
            modifier.ifElse(
                focusTarget,
                Modifier.focusRequester(focusRequester),
            ),
    )
}

/**
 * Plain (non-state) bookkeeping for how focus arrives in the drawer's list group, so the list can apply upstream's
 * entry rule (selected item, or Search when coming down from the header) even when Compose does not call `onEnter`.
 */
private class ListEntryTracker {
    var viaOnEnter = false
    var listHasFocus = false
    var lastRegion = NONE
    var stepFromSettings = false

    companion object {
        const val NONE = 0
        const val HEADER = 1
        const val LIST = 2
    }
}

/**
 * While the rail is collapsed, keeps the list row at [index] (the current page) whole in view: whenever the list's
 * layout changes (Now Playing appearing above it shrinks the list) and the row is cut or out of view, the list scrolls
 * just enough to show all of it.
 */
private suspend fun keepWhole(
    state: LazyListState,
    index: Int,
) {
    snapshotFlow { state.layoutInfo }.collect { info ->
        if (info.totalItemsCount <= index || info.viewportEndOffset <= info.viewportStartOffset) return@collect
        val row = info.visibleItemsInfo.firstOrNull { it.index == index }
        when {
            row == null -> {
                state.scrollToItem(index)
            }

            row.offset < info.viewportStartOffset -> {
                state.scrollBy((row.offset - info.viewportStartOffset).toFloat())
            }

            row.offset + row.size > info.viewportEndOffset -> {
                state.scrollBy((row.offset + row.size - info.viewportEndOffset).toFloat())
            }
        }
    }
}
