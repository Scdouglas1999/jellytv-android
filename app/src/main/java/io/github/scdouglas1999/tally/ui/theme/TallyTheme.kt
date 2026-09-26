package io.github.scdouglas1999.tally.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.ProvideTextStyle
import com.github.damontecres.wholphin.R
import io.github.scdouglas1999.tally.ui.formfactor.LocalTallyFormFactor
import io.github.scdouglas1999.tally.ui.formfactor.TallyFormFactor

/**
 * Tally design tokens: flat, near-black, hairline rules, square corners, one accent.
 * Same palette as the Tally web UI, TV-sized. See TALLY.md.
 */
object TallyColors {
    /** Screen background. */
    val ground = Color(0xFF0E0F0E)

    /** Focused card ground. */
    val groundRaised = Color(0xFF1B1C1A)

    /** Video / monitor faces. */
    val screen = Color(0xFF050505)

    /** Channel label bars. */
    val labelBar = Color(0xFF000000)

    /** Structural hairlines (1dp). */
    val rule = Color(0xFF2A2C2A)

    /** Control / card borders (1dp), idle indicator squares. */
    val ruleStrong = Color(0xFF3A3D38)

    /** Primary text. */
    val text = Color(0xFFE3E5DE)

    /** Secondary text. */
    val textSecondary = Color(0xFFA9ADA3)

    /** Captions, labels. */
    val muted = Color(0xFF8B9084)

    /** Focus frame, "now", active tab. Text on accent is [onAccent]. */
    val accent = Color(0xFFFFB000)

    /** Text/icons drawn on top of [accent]. */
    val onAccent = Color(0xFF0E0F0E)

    /** LIVE indicators (and failure). */
    val live = Color(0xFFFF3B30)

    /** Small live-red text. */
    val liveText = Color(0xFFFF6A61)
}

/**
 * IBM Plex Sans for reading, IBM Plex Mono for clocks, scores, and labels.
 * Mono labels are rendered UPPERCASE with letter spacing.
 */
object TallyType {
    val Sans =
        FontFamily(
            Font(R.font.ibm_plex_sans_regular, FontWeight.Normal),
            Font(R.font.ibm_plex_sans_medium, FontWeight.Medium),
            Font(R.font.ibm_plex_sans_semibold, FontWeight.SemiBold),
            Font(R.font.ibm_plex_sans_bold, FontWeight.Bold),
        )

    val Mono =
        FontFamily(
            Font(R.font.ibm_plex_mono_regular, FontWeight.Normal),
            Font(R.font.ibm_plex_mono_medium, FontWeight.Medium),
            Font(R.font.ibm_plex_mono_semibold, FontWeight.SemiBold),
        )

    /** Mono Medium 14sp, used UPPERCASE for league/channel/kicker labels. */
    val label =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 14.sp,
            letterSpacing = 2.sp,
        )

    /** Mono Medium 16sp, used UPPERCASE for tab and row headers. */
    val labelLarge =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            letterSpacing = 2.sp,
        )

    val clock =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
        )

    val score =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 30.sp,
        )

    val scoreHero =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 84.sp,
        )

    val teamCard =
        TextStyle(
            fontFamily = Sans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 20.sp,
        )

    val teamHero =
        TextStyle(
            fontFamily = Sans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 44.sp,
        )

    val body =
        TextStyle(
            fontFamily = Sans,
            fontWeight = FontWeight.Normal,
            fontSize = 20.sp,
            lineHeight = 28.sp,
        )

    val situation =
        TextStyle(
            fontFamily = Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 26.sp,
        )

    val hint =
        TextStyle(
            fontFamily = Sans,
            fontWeight = FontWeight.Normal,
            fontSize = 15.sp,
        )
}

object TallyDimens {
    /** Safe margins: 48dp left/right, 27dp top/bottom. */
    val marginHorizontal = 48.dp
    val marginVertical = 27.dp

    val cardWidth = 300.dp
    val cardHeight = 176.dp
    val cardGap = 18.dp

    /** Focused element border width. */
    val focusBorder = 3.dp

    /** Structural hairline width. */
    val hairline = 1.dp

    val topBarHeight = 78.dp
    val heroHeight = 312.dp
}

/**
 * Phone type: the same families as [TallyType], sized for a hand. Mono labels are used UPPERCASE
 * (`tallyUppercase()`), as on the TV.
 */
object PhoneType {
    /** Sans SemiBold 28/34sp. */
    val display =
        TextStyle(
            fontFamily = TallyType.Sans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 28.sp,
            lineHeight = 34.sp,
        )

    /** Sans SemiBold 22/28sp. */
    val title =
        TextStyle(
            fontFamily = TallyType.Sans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 22.sp,
            lineHeight = 28.sp,
        )

    /** Sans Medium 17/22sp. */
    val headline =
        TextStyle(
            fontFamily = TallyType.Sans,
            fontWeight = FontWeight.Medium,
            fontSize = 17.sp,
            lineHeight = 22.sp,
        )

    /** Sans 15/22sp. */
    val body =
        TextStyle(
            fontFamily = TallyType.Sans,
            fontWeight = FontWeight.Normal,
            fontSize = 15.sp,
            lineHeight = 22.sp,
        )

    /** Sans 13/18sp. */
    val bodySmall =
        TextStyle(
            fontFamily = TallyType.Sans,
            fontWeight = FontWeight.Normal,
            fontSize = 13.sp,
            lineHeight = 18.sp,
        )

    /** Mono Medium 11sp, 0.14em, used UPPERCASE. */
    val label =
        TextStyle(
            fontFamily = TallyType.Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 11.sp,
            letterSpacing = 0.14.em,
        )

    /** Mono Medium 13sp, 0.12em, used UPPERCASE. */
    val labelLarge =
        TextStyle(
            fontFamily = TallyType.Mono,
            fontWeight = FontWeight.Medium,
            fontSize = 13.sp,
            letterSpacing = 0.12.em,
        )

    /** Mono 12sp: metadata lines, times. */
    val meta =
        TextStyle(
            fontFamily = TallyType.Mono,
            fontWeight = FontWeight.Normal,
            fontSize = 12.sp,
        )

    /** Mono SemiBold 22sp. */
    val score =
        TextStyle(
            fontFamily = TallyType.Mono,
            fontWeight = FontWeight.SemiBold,
            fontSize = 22.sp,
        )

    /** Mono SemiBold 40sp. */
    val scoreHero =
        TextStyle(
            fontFamily = TallyType.Mono,
            fontWeight = FontWeight.SemiBold,
            fontSize = 40.sp,
        )
}

/** Phone sizes. Phone layouts use these, never [TallyScale] (a no-op on phones). */
object PhoneDimens {
    /** Page side margin. */
    val margin = 16.dp
    val gutter = 12.dp

    /** Between the rows of a page. */
    val rowGap = 28.dp

    /** Between the cards of a row. */
    val cardGap = 10.dp

    /** 2:3 poster. */
    val posterWidth = 112.dp

    /** 16:9 card. */
    val landscapeCardWidth = 248.dp
    val gameCardWidth = 280.dp
    val topBarHeight = 56.dp

    /** The bottom bar, without the gesture-bar inset under it. */
    val bottomBarHeight = 64.dp

    /** Minimum touch target. */
    val touchTarget = 48.dp
    val hairline = 1.dp

    /** Focus border, drawn only while a keyboard or D-pad is in use. */
    val focusBorder = 2.dp

    /**
     * The widest a page's row of full-width buttons runs: on a phone they span the page, on a tablet they stop here,
     * at about the width they have on a large phone (a 432dp screen less its margins), instead of stretching across it.
     */
    val buttonMaxWidth = 400.dp

    /**
     * At or above this width (a tablet) the games list is laid out in columns: as many as fit [gameCardWidth] wide,
     * each card at most [gameCardMaxWidth].
     */
    val twoColumnMinWidth = 600.dp

    /** The widest a game card grows in a tablet's games list. */
    val gameCardMaxWidth = 360.dp
}

/**
 * Full-size surface on [TallyColors.ground] that sets [TallyColors.text] as the content color and
 * [TallyType.body] as the default text style. Root of every Tally screen.
 */
@Composable
fun TallySurface(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    TallyScale {
        CompositionLocalProvider(LocalContentColor provides TallyColors.text) {
            ProvideTextStyle(TallyType.body) {
                Box(
                    modifier =
                        modifier
                            .fillMaxSize()
                            .background(TallyColors.ground),
                    content = content,
                )
            }
        }
    }
}

/**
 * Every Tally dimension (dp and sp) is authored against a 1200 x 675 canvas: the 1920 x 1080 mockups at
 * 0.625, i.e. 20% larger than drawn, for reading from a sofa. A TV is 960 x 540 dp, so Tally UI is laid out
 * at 0.8 of the real density. Anything drawn outside a [TallySurface] (the overlays on top of the upstream
 * player) must be wrapped in this too. On a phone it does nothing.
 */
@Composable
fun TallyScale(content: @Composable () -> Unit) {
    // Phone layouts are sized in phone dp (PhoneDimens): the TV canvas shrink does not apply.
    if (LocalTallyFormFactor.current == TallyFormFactor.PHONE) {
        content()
        return
    }
    val density = LocalDensity.current
    val scaled = remember(density) { Density(density.density * JTV_SCALE, density.fontScale) }
    CompositionLocalProvider(LocalDensity provides scaled, content = content)
}

private const val JTV_SCALE = 0.8f
