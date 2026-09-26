package io.github.scdouglas1999.tally

import androidx.compose.ui.unit.dp
import io.github.scdouglas1999.tally.ui.phone.phoneGameCardWidth
import io.github.scdouglas1999.tally.ui.phone.phoneGameColumns
import io.github.scdouglas1999.tally.ui.theme.PhoneDimens
import org.junit.Assert
import org.junit.Test

/** The games list: one full-width card on a phone, capped cards in columns on a tablet. */
class PhoneGameColumnsTest {
    @Test
    fun `a phone has one full-width column`() {
        Assert.assertEquals(1, phoneGameColumns(411.dp))
        Assert.assertNull(phoneGameCardWidth(411.dp, 1))
    }

    @Test
    fun `a tablet fits more columns, never wider than the maximum`() {
        for (width in listOf(600, 800, 900, 1024, 1280, 1400)) {
            val columns = phoneGameColumns(width.dp)
            Assert.assertTrue("columns at $width", columns >= 2)
            val card = phoneGameCardWidth(width.dp, columns)!!
            Assert.assertTrue("card at $width is $card", card <= PhoneDimens.gameCardMaxWidth)
            Assert.assertTrue("card at $width is $card", card >= PhoneDimens.gameCardWidth || columns == 2)
        }
        Assert.assertEquals(2, phoneGameColumns(800.dp))
        Assert.assertEquals(4, phoneGameColumns(1280.dp))
    }
}
