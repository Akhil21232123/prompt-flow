package com.akhil.promptflow.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

class ApiException(message: String, val status: Int = 0, val code: String = "") : IOException(message)

/**
 * Talks to the PromptFlow backend (Supabase): email sign-in with a 6-digit
 * code, the dictate/rewrite/learn functions, and the user's own rows.
 * Plain HttpURLConnection to keep the app small.
 */
class Api(private val store: Store) {

    private val base get() = store.serverUrl
    private val anon get() = store.anonKey

    // ---------------------------------------------------------------- auth

    /** Sign-in results from the emailed link: null = signed in, else the error message. */
    private val _authEvents = MutableSharedFlow<String?>(extraBufferCapacity = 4)
    val authEvents: SharedFlow<String?> = _authEvents

    /** Emails a sign-in link back to promptflow://auth (plus a code when the template has one). */
    suspend fun sendCode(email: String) {
        request(
            "POST", "/auth/v1/otp?redirect_to=" + URLEncoder.encode("promptflow://auth", "UTF-8"),
            JSONObject().put("email", email.trim()).put("create_user", true), auth = false,
        )
    }

    /** Finishes sign-in from promptflow://auth#access_token=…&refresh_token=… */
    suspend fun completeLink(link: String): Session {
        try {
            val params = linkParams(link)
            params["error_description"]?.let { throw ApiException(it, 401, "auth") }
            val refresh = params["refresh_token"]
                ?: throw ApiException("That sign-in link is incomplete. Ask for a new one.", 401, "auth")
            val res = request(
                "POST", "/auth/v1/token?grant_type=refresh_token",
                JSONObject().put("refresh_token", refresh), auth = false,
            )
            return Session.fromAuthResponse(JSONObject(res)).also {
                store.session = it
                _authEvents.tryEmit(null)
            }
        } catch (e: Exception) {
            _authEvents.tryEmit(e.message ?: "Couldn't sign in")
            throw e
        }
    }

    suspend fun verifyCode(email: String, code: String): Session {
        val res = request(
            "POST", "/auth/v1/verify",
            JSONObject().put("type", "email").put("email", email.trim()).put("token", code.trim()),
            auth = false,
        )
        return Session.fromAuthResponse(JSONObject(res), email.trim()).also {
            store.session = it
            _authEvents.tryEmit(null)
        }
    }

    fun signOut() {
        store.session = null
    }

    private suspend fun validSession(): Session {
        val s = store.session ?: throw ApiException("Sign in to PromptFlow first", 401, "auth")
        if (!s.isExpired) return s
        val res = request(
            "POST", "/auth/v1/token?grant_type=refresh_token",
            JSONObject().put("refresh_token", s.refreshToken), auth = false,
        )
        return Session.fromAuthResponse(JSONObject(res), s.email).also { store.session = it }
    }

    // ------------------------------------------------------------ dictation

    suspend fun dictate(
        wav: ByteArray,
        mode: Mode,
        app: AppContext?,
        selection: String?,
        durationSec: Double,
    ): DictationResult {
        val meta = JSONObject()
            .put("mode", mode.wire)
            .put("duration_sec", durationSec)
            .put("device", "android")
        app?.let { meta.put("app", it.toJson()) }
        selection?.takeIf { it.isNotBlank() }?.let { meta.put("selection", it) }
        if (mode == Mode.Dictate) meta.put("preset", store.stylePreset.wire)
        val res = multipart("/functions/v1/dictate", meta, wav)
        return DictationResult.fromJson(JSONObject(res))
    }

    suspend fun learn(original: String, edited: String): List<String> {
        val res = request(
            "POST", "/functions/v1/learn",
            JSONObject().put("original", original).put("edited", edited),
        )
        return JSONObject(res).optJSONArray("learned").strings()
    }

    // -------------------------------------------------------- user's rows

    suspend fun dictionary(): List<DictionaryWord> {
        val arr = JSONArray(request("GET", "/rest/v1/dictionary_words?select=id,word,source&order=created_at.desc"))
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            DictionaryWord(o.getString("id"), o.getString("word"), o.optString("source"))
        }
    }

    suspend fun addWord(word: String) {
        val s = validSession()
        request(
            "POST", "/rest/v1/dictionary_words",
            JSONArray().put(JSONObject().put("user_id", s.userId).put("word", word.trim())),
            prefer = "resolution=ignore-duplicates,return=minimal",
        )
    }

    suspend fun deleteWord(id: String) {
        request("DELETE", "/rest/v1/dictionary_words?id=eq.${enc(id)}")
    }

    suspend fun snippets(): List<Snippet> {
        val arr = JSONArray(request("GET", "/rest/v1/snippets?select=id,trigger,expansion&order=created_at.desc"))
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Snippet(o.getString("id"), o.getString("trigger"), o.getString("expansion"))
        }
    }

    suspend fun saveSnippet(trigger: String, expansion: String, id: String? = null) {
        val s = validSession()
        val body = JSONObject().put("user_id", s.userId).put("trigger", trigger.trim()).put("expansion", expansion)
        if (id == null) request("POST", "/rest/v1/snippets", JSONArray().put(body), prefer = "return=minimal")
        else request("PATCH", "/rest/v1/snippets?id=eq.${enc(id)}", body, prefer = "return=minimal")
    }

    suspend fun deleteSnippet(id: String) {
        request("DELETE", "/rest/v1/snippets?id=eq.${enc(id)}")
    }

    suspend fun settings(): JSONObject {
        val arr = JSONArray(request("GET", "/rest/v1/user_settings?select=settings&limit=1"))
        return if (arr.length() > 0) arr.getJSONObject(0).optJSONObject("settings") ?: JSONObject() else JSONObject()
    }

    suspend fun saveSettings(settings: JSONObject) {
        val s = validSession()
        request(
            "POST", "/rest/v1/user_settings?on_conflict=user_id",
            JSONObject().put("user_id", s.userId).put("settings", settings),
            prefer = "resolution=merge-duplicates,return=minimal",
        )
    }

    // ------------------------------------------------------------ plumbing

    private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")

    private fun open(method: String, path: String): HttpURLConnection {
        if (!store.isServerConfigured) throw ApiException("Add the PromptFlow server in Settings", 0, "config")
        return (URL(base + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 60_000
            setRequestProperty("apikey", anon)
            setRequestProperty("x-client-info", "promptflow-android/0.1")
        }
    }

    private suspend fun request(
        method: String,
        path: String,
        body: Any? = null,
        auth: Boolean = true,
        prefer: String? = null,
    ): String = withContext(Dispatchers.IO) {
        val conn = open(method, path)
        // Signed-out calls send only the apikey: new-style publishable keys
        // (sb_publishable_…) aren't JWTs and are refused as a Bearer token.
        if (auth) conn.setRequestProperty("Authorization", "Bearer ${validSession().accessToken}")
        else if (anon.startsWith("eyJ")) conn.setRequestProperty("Authorization", "Bearer $anon")
        prefer?.let { conn.setRequestProperty("Prefer", it) }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        read(conn)
    }

    private suspend fun multipart(path: String, meta: JSONObject, wav: ByteArray): String =
        withContext(Dispatchers.IO) {
            val token = validSession().accessToken
            val boundary = "PF" + UUID.randomUUID().toString().replace("-", "")
            val conn = open("POST", path)
            conn.doOutput = true
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            val out = ByteArrayOutputStream()
            fun line(s: String) = out.write((s + "\r\n").toByteArray())
            line("--$boundary")
            line("Content-Disposition: form-data; name=\"meta\"")
            line("Content-Type: application/json")
            line("")
            line(meta.toString())
            line("--$boundary")
            line("Content-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"")
            line("Content-Type: audio/wav")
            line("")
            out.write(wav)
            line("")
            line("--$boundary--")
            conn.setFixedLengthStreamingMode(out.size())
            conn.outputStream.use { it.write(out.toByteArray()) }
            read(conn)
        }

    private fun read(conn: HttpURLConnection): String {
        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val err = runCatching { JSONObject(text) }.getOrNull()
                val message = err?.optString("error")?.takeIf { it.isNotBlank() }
                    ?: err?.optString("msg")?.takeIf { it.isNotBlank() }
                    ?: err?.optString("error_description")?.takeIf { it.isNotBlank() }
                    ?: "Server error ($status)"
                throw ApiException(message, status, err?.optString("code").orEmpty())
            }
            return text
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        /** Key/value pairs from a link's query and fragment, form-decoded. */
        fun linkParams(link: String): Map<String, String> {
            val parts = link.substringAfter('?', "").substringBefore('#') + "&" + link.substringAfter('#', "")
            return parts.split('&').mapNotNull { pair ->
                val i = pair.indexOf('=')
                if (i <= 0) null
                else pair.substring(0, i) to java.net.URLDecoder.decode(pair.substring(i + 1), "UTF-8")
            }.toMap()
        }
    }
}
