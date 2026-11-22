package com.akhil.promptflow.core

import android.content.Context
import android.content.SharedPreferences
import com.akhil.promptflow.BuildConfig
import org.json.JSONArray
import org.json.JSONObject

/** Small persistent store for the session, server address and local history. */
class Store(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("promptflow", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("server_url", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.SUPABASE_URL
        set(v) = prefs.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var anonKey: String
        get() = prefs.getString("anon_key", null)?.takeIf { it.isNotBlank() } ?: BuildConfig.SUPABASE_ANON_KEY
        set(v) = prefs.edit().putString("anon_key", v.trim()).apply()

    val isServerConfigured: Boolean get() = serverUrl.startsWith("https://") && anonKey.isNotBlank()

    var session: Session?
        get() = prefs.getString("session", null)?.let { runCatching { Session.fromJson(JSONObject(it)) }.getOrNull() }
        set(v) = prefs.edit().putString("session", v?.toJson()?.toString()).apply()

    var onboarded: Boolean
        get() = prefs.getBoolean("onboarded", false)
        set(v) = prefs.edit().putBoolean("onboarded", v).apply()

    var haptics: Boolean
        get() = prefs.getBoolean("haptics", true)
        set(v) = prefs.edit().putBoolean("haptics", v).apply()

    var bubbleY: Int
        get() = prefs.getInt("bubble_y", -1)
        set(v) = prefs.edit().putInt("bubble_y", v).apply()

    var bubbleOnRight: Boolean
        get() = prefs.getBoolean("bubble_right", true)
        set(v) = prefs.edit().putBoolean("bubble_right", v).apply()

    /** Last 200 dictations on this phone, newest first (works offline). */
    fun history(): List<HistoryItem> {
        val raw = prefs.getString("history", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { HistoryItem.fromJson(arr.getJSONObject(it)) }
        }.getOrDefault(emptyList())
    }

    fun addHistory(item: HistoryItem) {
        val items = listOf(item) + history().take(199)
        val arr = JSONArray()
        items.forEach { arr.put(it.toJson()) }
        prefs.edit().putString("history", arr.toString()).apply()
    }

    fun clearHistory() = prefs.edit().remove("history").apply()

    var wordsDictated: Long
        get() = prefs.getLong("words", 0)
        set(v) = prefs.edit().putLong("words", v).apply()
}
