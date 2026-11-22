package com.akhil.promptflow

import com.akhil.promptflow.core.DictationResult
import com.akhil.promptflow.core.Mode
import com.akhil.promptflow.core.Session
import com.akhil.promptflow.core.Wav
import com.akhil.promptflow.core.wordCount
import com.akhil.promptflow.service.TextInserter
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreTest {
    @Test fun wavHeader() {
        val wav = Wav.encode(ByteArray(10), 16_000)
        assertEquals(54, wav.size)
        assertArrayEquals("RIFF".toByteArray(), wav.copyOfRange(0, 4))
        assertArrayEquals("WAVE".toByteArray(), wav.copyOfRange(8, 12))
        // sample rate, little-endian, at byte 24
        assertEquals(16_000, (wav[24].toInt() and 0xff) or ((wav[25].toInt() and 0xff) shl 8))
    }

    @Test fun spacingWhenInsertingAfterAWord() {
        assertEquals(" hello", TextInserter.joinable("Hi", "hello"))
        assertEquals(", ok", TextInserter.joinable("Hi", ", ok"))
        assertEquals("hello", TextInserter.joinable("Hi ", "hello"))
        assertEquals("hello", TextInserter.joinable("", "hello"))
        assertEquals(".", TextInserter.joinable("done", "."))
    }

    @Test fun parsesAuthResponse() {
        val s = Session.fromAuthResponse(
            JSONObject("""{"access_token":"a","refresh_token":"r","expires_in":3600,"user":{"id":"u1","email":"a@b.co"}}"""),
        )
        assertEquals("u1", s.userId)
        assertEquals("a@b.co", s.email)
        assertTrue(!s.isExpired)
        assertEquals(s, Session.fromJson(s.toJson()))
    }

    @Test fun parsesDictationResult() {
        val r = DictationResult.fromJson(
            JSONObject("""{"raw":"hi","text":"Hi.","mode":"engineer","label":"x","guarded":["number 99"],"timing":{"total_ms":812}}"""),
        )
        assertEquals(Mode.Engineer, r.mode)
        assertEquals(listOf("number 99"), r.guarded)
        assertEquals(812, r.totalMs)
    }

    @Test fun countsWords() {
        assertEquals(3, "  one two\nthree ".wordCount())
        assertEquals(0, "   ".wordCount())
    }

    @Test
    fun signInLinkParams() {
        val ok = com.akhil.promptflow.core.Api.linkParams(
            "promptflow://auth#access_token=a&expires_in=3600&refresh_token=r1&type=magiclink",
        )
        assertEquals("r1", ok["refresh_token"])
        val bad = com.akhil.promptflow.core.Api.linkParams(
            "promptflow://auth#error=access_denied&error_description=Email+link+is+invalid+or+has+expired",
        )
        assertEquals("Email link is invalid or has expired", bad["error_description"])
    }

    @Test
    fun silenceHasNoVoicedFrames() {
        val room = List(40) { 0.004f + (it % 3) * 0.001f }
        assertEquals(0, com.akhil.promptflow.core.Recorder.voicedFrames(room))
        val speech = room + List(12) { 0.09f } + room
        assertEquals(12, com.akhil.promptflow.core.Recorder.voicedFrames(speech))
        val allSpeech = List(30) { 0.06f + (it % 5) * 0.03f }
        assertTrue(com.akhil.promptflow.core.Recorder.voicedFrames(allSpeech) >= 24)
    }
}
