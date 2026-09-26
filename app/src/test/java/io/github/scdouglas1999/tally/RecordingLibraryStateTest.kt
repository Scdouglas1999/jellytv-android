package io.github.scdouglas1999.tally

import io.github.scdouglas1999.tally.api.TallyJson
import io.github.scdouglas1999.tally.dvr.DvrList
import io.github.scdouglas1999.tally.dvr.LibraryAvailability
import io.github.scdouglas1999.tally.dvr.libraryAvailability
import io.github.scdouglas1999.tally.dvr.ui.RecordingsSections
import org.junit.Assert.assertEquals
import org.junit.Test

/** A finished recording's `libraryState` (contract 3 of 2.2), from new and old plugins, and the TV list's focus layout. */
class RecordingLibraryStateTest {
    /** A finished job as the plugin's RecordingsController sends it, with [extra] fields. */
    private fun job(
        id: String,
        extra: String,
    ): String =
        "{\"id\":\"$id\",\"ruleId\":\"r\",\"state\":\"done\",\"title\":\"Harbor Hawks at Mesa Owls\"," +
            "\"game\":{\"id\":\"900001\",\"league\":\"MLB\",\"leaguePath\":\"baseball/mlb\"},\"seconds\":72$extra}"

    private val list: DvrList =
        TallyJson.decodeFromString(
            "{\"canManage\":true," +
                "\"rules\":[{\"id\":\"rule1\",\"kind\":\"team\",\"title\":\"Every Hawks game\",\"teamId\":\"900441\"}]," +
                "\"jobs\":[" +
                "{\"id\":\"rec1\",\"state\":\"recording\",\"title\":\"a\",\"game\":{\"id\":\"1\"}}," +
                "{\"id\":\"sch1\",\"state\":\"scheduled\",\"title\":\"b\",\"game\":{\"id\":\"2\",\"start\":\"2026-09-26T17:00:00Z\"}}," +
                job("d1", ",\"itemId\":\"d5a180cfbae548e4ad0d94b83a0179c8\",\"libraryState\":\"ready\"") + "," +
                job("d2", ",\"libraryState\":\"adding\"") + "," +
                job("d3", ",\"libraryState\":\"noLibrary\"") + "," +
                job("d4", "") + "," +
                job("d5", ",\"libraryState\":\"somethingNew\"") + "," +
                "{\"id\":\"fail1\",\"state\":\"failed\",\"reason\":\"No stream\",\"title\":\"c\",\"game\":{\"id\":\"3\"}}]}",
        )

    private fun done() = list.jobs.filter { it.state == "done" }

    @Test
    fun `library state from the plugin, and the old plugin's missing field`() {
        assertEquals(
            listOf(
                LibraryAvailability.READY,
                LibraryAvailability.ADDING,
                LibraryAvailability.NO_LIBRARY,
                // an older plugin sends no libraryState: no itemId means it is still being added
                LibraryAvailability.ADDING,
                // a value this app does not know yet reads like "adding"
                LibraryAvailability.ADDING,
            ),
            done().map { it.libraryAvailability },
        )
        assertEquals("noLibrary", done()[2].libraryState)
    }

    @Test
    fun `focus order and lazy items of the TV list`() {
        val sections = RecordingsSections.of(list)
        val recorded = done().map { it.id }
        assertEquals(listOf("rec1", "sch1") + recorded + listOf("fail1", "rule1"), sections.focusOrder())
        // storage 0, RECORDING NOW header 1 + row 2, SCHEDULED header 3 + row 4, RECORDED header 5 + one row of
        // cards 6, FAILED header 7 + row 8, TEAM RULES header 9 + row 10
        val expected = mapOf("rec1" to 2, "sch1" to 4, "fail1" to 8, "rule1" to 10) + recorded.associateWith { 6 }
        assertEquals(expected, sections.lazyIndices())
    }

    @Test
    fun `lazy items when the recording moved on`() {
        val finished = list.copy(jobs = list.jobs.filter { it.id != "rec1" })
        val sections = RecordingsSections.of(finished)
        assertEquals(mapOf("sch1" to 2, "fail1" to 6, "rule1" to 8) + done().associate { it.id to 4 }, sections.lazyIndices())
    }
}
