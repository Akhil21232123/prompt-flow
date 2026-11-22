package com.akhil.promptflow.core

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * 16 kHz mono PCM capture, the format speech models expect. Reports a 0..1
 * level for the waveform while recording.
 */
class Recorder(private val onLevel: (Float) -> Unit) {
    private var record: AudioRecord? = null
    private var worker: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var running = false
    private var startedAt = 0L

    val isRecording: Boolean get() = running

    /** Requires RECORD_AUDIO, checked by the caller. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) return false
        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            maxOf(min, RATE / 5 * 2),
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        pcm.reset()
        record = rec
        running = true
        startedAt = System.currentTimeMillis()
        rec.startRecording()
        worker = thread(name = "pf-recorder", priority = Thread.MAX_PRIORITY) {
            val buf = ShortArray(RATE / 20) // 50 ms
            val bytes = ByteBuffer.allocate(buf.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                bytes.clear()
                var sum = 0.0
                for (i in 0 until n) {
                    bytes.putShort(buf[i])
                    val v = buf[i] / 32768.0
                    sum += v * v
                }
                synchronized(pcm) { pcm.write(bytes.array(), 0, n * 2) }
                val rms = sqrt(sum / n).toFloat()
                onLevel((rms * 6f).coerceIn(0f, 1f))
            }
        }
        return true
    }

    /** Stops and returns a WAV file plus its duration in seconds. */
    fun stop(): Pair<ByteArray, Double> {
        running = false
        worker?.join(500)
        worker = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
        val data = synchronized(pcm) { pcm.toByteArray() }
        val seconds = data.size / 2.0 / RATE
        onLevel(0f)
        return Wav.encode(data, RATE) to seconds
    }

    fun cancel() {
        stop()
        pcm.reset()
    }

    companion object {
        const val RATE = 16_000
    }
}

object Wav {
    /** Wraps little-endian 16-bit mono PCM in a WAV header. */
    fun encode(pcm: ByteArray, rate: Int): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1)
            putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(pcm.size)
        }
        return header.array() + pcm
    }
}
