package io.github.scdouglas1999.tally.dvr.ui

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.github.damontecres.wholphin.R
import com.github.damontecres.wholphin.ui.tryRequestFocus
import io.github.scdouglas1999.tally.dvr.LibraryAvailability
import io.github.scdouglas1999.tally.media.kit.TallyButton
import io.github.scdouglas1999.tally.ui.settings.FOCUS_ROOM
import io.github.scdouglas1999.tally.ui.settings.OPEN_GRACE_MS
import io.github.scdouglas1999.tally.ui.settings.TallyPanelFrame
import io.github.scdouglas1999.tally.ui.settings.TallyPanelWindow
import io.github.scdouglas1999.tally.ui.settings.phone.PhoneButton
import io.github.scdouglas1999.tally.ui.settings.phone.PhoneButtonKind
import io.github.scdouglas1999.tally.ui.settings.phone.isPhone
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import io.github.scdouglas1999.tally.ui.theme.PhoneType
import io.github.scdouglas1999.tally.ui.theme.TallyColors
import io.github.scdouglas1999.tally.ui.theme.TallyType
import kotlinx.coroutines.delay

/**
 * Why a finished recording does not play yet (it has no library item): still being added, or the server has no
 * library for recordings. Tally's panel on a TV (OK or BACK closes it), a bottom sheet on a phone.
 */
@Composable
fun RecordingLibraryNotice(
    availability: LibraryAvailability,
    onDismiss: () -> Unit,
) {
    val message =
        stringResource(
            if (availability == LibraryAvailability.NO_LIBRARY) {
                R.string.tally_dvr_no_library
            } else {
                R.string.tally_dvr_still_adding
            },
        )
    val kicker = stringResource(R.string.tally_dvr_not_ready_kicker)
    // the OK that opened the notice must not also close it
    val openedAt = remember { SystemClock.elapsedRealtime() }
    val close = { if (SystemClock.elapsedRealtime() - openedAt >= OPEN_GRACE_MS) onDismiss() }
    TallyPanelWindow(onDismissRequest = onDismiss) {
        TallyPanelFrame(kicker = kicker, onBack = onDismiss, width = 520.dp, trapHorizontal = false) {
            if (isPhone()) {
                Text(
                    text = message,
                    style = PhoneType.body,
                    color = TallyColors.text,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = PhoneDimens.margin).padding(top = 16.dp),
                )
                Column(
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = PhoneDimens.margin).padding(top = 20.dp, bottom = 8.dp),
                ) {
                    PhoneButton(
                        label = stringResource(R.string.tally_dvr_notice_ok),
                        onClick = close,
                        kind = PhoneButtonKind.PRIMARY,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            } else {
                val okFocus = remember { FocusRequester() }
                LaunchedEffect(Unit) {
                    repeat(FOCUS_TRIES) {
                        if (okFocus.tryRequestFocus("tally-recording-notice")) return@LaunchedEffect
                        delay(FOCUS_RETRY_MS)
                    }
                }
                Text(
                    text = message,
                    style = messageStyle,
                    color = TallyColors.text,
                    modifier = Modifier.padding(horizontal = 20.dp).padding(top = FOCUS_ROOM),
                )
                Row(Modifier.padding(horizontal = 20.dp).padding(top = 18.dp, bottom = 20.dp)) {
                    TallyButton(
                        label = stringResource(R.string.tally_dvr_notice_ok),
                        onClick = close,
                        primary = true,
                        modifier = Modifier.focusRequester(okFocus),
                    )
                }
            }
        }
    }
}

private const val FOCUS_TRIES = 8
private const val FOCUS_RETRY_MS = 40L

private val messageStyle =
    TextStyle(
        fontFamily = TallyType.Sans,
        fontWeight = FontWeight.Normal,
        fontSize = 17.sp,
        lineHeight = 24.sp,
    )
