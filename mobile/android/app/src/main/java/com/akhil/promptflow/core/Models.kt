package com.akhil.promptflow.core

import org.json.JSONArray
import org.json.JSONObject

enum class Mode(val wire: String, val label: String) {
    Dictate("dictate", "Dictate"),
    Engineer("engineer", "Prompt"),
    Command("command", "Edit");

    companion object {
        fun from(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Dictate
    }
}

/** How a double-tap dictation is written (single tap always engineers a prompt). */
enum class StylePreset(val wire: String, val label: String, val hint: String) {
    Clean("clean", "Clean", "Your words, tidied: no fillers, fixed grammar."),
    Formal("formal", "Formal", "Professional and polished."),
    Short("short", "Short & punchy", "Straight to the point, half the length."),
    Casual("casual", "Casual", "Relaxed and friendly."),
    Bullets("bullets", "Bullets", "A tight bulleted list."),
    Custom("custom", "Custom", "Your own instruction, set in Settings.");

    companion object {
        fun from(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Clean
    }
}

/** Gesture timings shared by the keyboard, the bubble and the in-app orb. */
object Gestures {
    const val DOUBLE_TAP_MS = 350L
    const val HOLD_MS = 450L
}

data class Session(
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long,
    val email: String,
    val userId: String,
) {
    val isExpired: Boolean get() = System.currentTimeMillis() / 1000 > expiresAt - 60

    fun toJson(): JSONObject = JSONObject()
        .put("access_token", accessToken)
        .put("refresh_token", refreshToken)
        .put("expires_at", expiresAt)
        .put("email", email)
        .put("user_id", userId)

    companion object {
        fun fromJson(o: JSONObject) = Session(
            accessToken = o.getString("access_token"),
            refreshToken = o.getString("refresh_token"),
            expiresAt = o.optLong("expires_at"),
            email = o.optString("email"),
            userId = o.optString("user_id"),
        )

        /** Parses a GoTrue token response. */
        fun fromAuthResponse(o: JSONObject, fallbackEmail: String = ""): Session {
            val user = o.optJSONObject("user")
            val expiresAt = if (o.has("expires_at")) o.getLong("expires_at")
            else System.currentTimeMillis() / 1000 + o.optLong("expires_in", 3600)
            return Session(
                accessToken = o.getString("access_token"),
                refreshToken = o.getString("refresh_token"),
                expiresAt = expiresAt,
                email = user?.optString("email")?.takeIf { it.isNotBlank() } ?: fallbackEmail,
                userId = user?.optString("id").orEmpty(),
            )
        }
    }
}

/** The app the user is typing into, sent so the server can match tone. */
data class AppContext(
    val name: String? = null,
    val packageName: String? = null,
    val surroundingText: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        name?.let { put("name", it) }
        packageName?.let { put("bundle_id", it) }
        surroundingText?.takeIf { it.isNotBlank() }?.let { put("surrounding_text", it.takeLast(1500)) }
    }
}

data class DictationResult(
    val raw: String,
    val text: String,
    val mode: Mode,
    val label: String,
    val guarded: List<String>,
    val dropped: Boolean,
    val totalMs: Long,
) {
    companion object {
        fun fromJson(o: JSONObject) = DictationResult(
            raw = o.optString("raw"),
            text = o.optString("text"),
            mode = Mode.from(o.optString("mode")),
            label = o.optString("label"),
            guarded = o.optJSONArray("guarded").strings(),
            dropped = o.optBoolean("dropped"),
            totalMs = o.optJSONObject("timing")?.optLong("total_ms") ?: 0,
        )
    }
}

data class HistoryItem(
    val at: Long,
    val app: String,
    val mode: Mode,
    val raw: String,
    val text: String,
    val label: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("at", at).put("app", app).put("mode", mode.wire)
        .put("raw", raw).put("text", text).put("label", label)

    companion object {
        fun fromJson(o: JSONObject) = HistoryItem(
            at = o.optLong("at"),
            app = o.optString("app"),
            mode = Mode.from(o.optString("mode")),
            raw = o.optString("raw"),
            text = o.optString("text"),
            label = o.optString("label"),
        )
    }
}

data class DictionaryWord(val id: String, val word: String, val source: String)
data class Snippet(val id: String, val trigger: String, val expansion: String)

fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { optString(it) }

/** Count of words, for the "words dictated" stat. */
fun String.wordCount(): Int = trim().split(Regex("\\s+")).count { it.isNotBlank() }
