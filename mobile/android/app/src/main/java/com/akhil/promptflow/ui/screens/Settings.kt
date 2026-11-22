package com.akhil.promptflow.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.ui.components.Card
import com.akhil.promptflow.ui.components.GradientButton
import kotlinx.coroutines.launch
import org.json.JSONObject

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen() {
    val app = PromptFlowApp.instance
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf(JSONObject()) }
    var signedIn by remember { mutableStateOf(app.store.session != null) }
    LaunchedEffect(signedIn) {
        if (signedIn) runCatching { settings = app.api.settings() }
    }
    fun update(change: (JSONObject) -> Unit) {
        val next = JSONObject(settings.toString()).also(change)
        settings = next
        scope.launch { runCatching { app.api.saveSettings(next) } }
    }
    fun styles() = settings.optJSONObject("styles") ?: JSONObject()
    fun engineer() = settings.optJSONObject("engineer") ?: JSONObject()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)

        Card {
            Column {
                Text("Account", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                if (signedIn) {
                    Text(app.store.session?.email.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { app.api.signOut(); signedIn = false }) { Text("Sign out") }
                } else {
                    AccountForm(onSignedIn = { signedIn = true })
                }
            }
        }

        Section("Style", "How formal your writing is in each kind of app.") {
            listOf("email" to "Email", "work_chat" to "Work messages", "personal_chat" to "Personal messages", "docs" to "Documents", "other" to "Other")
                .forEach { (key, label) ->
                    Text(label, style = MaterialTheme.typography.bodyMedium)
                    val current = styles().optString(key, if (key == "email" || key == "docs") "formal" else "casual")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("formal" to "Formal", "casual" to "Casual", "very_casual" to "Very casual").forEach { (v, l) ->
                            FilterChip(selected = current == v, onClick = {
                                update { it.put("styles", JSONObject(styles().toString()).put(key, v)) }
                            }, label = { Text(l) })
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                }
        }

        Section("Prompt Engineer", "Balanced writes the prompt, then a second pass critiques and improves it.") {
            val q = engineer().optString("quality", "balanced")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("fast" to "Fast", "balanced" to "Balanced", "max" to "Max").forEach { (v, l) ->
                    FilterChip(selected = q == v, onClick = {
                        update { it.put("engineer", JSONObject(engineer().toString()).put("quality", v)) }
                    }, label = { Text(l) })
                }
            }
            ToggleRow("Auto in AI apps", "Turn dictation into a prompt in ChatGPT, Claude and Gemini.", engineer().optBoolean("auto_in_ai_apps", true)) { on ->
                update { it.put("engineer", JSONObject(engineer().toString()).put("auto_in_ai_apps", on)) }
            }
        }

        Section("Language", "English is most accurate for Indian-accented speech with some Hindi words. Auto handles other languages.") {
            val lang = settings.optString("language", "en")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("en" to "English", "hi" to "Hindi", "auto" to "Auto-detect").forEach { (v, l) ->
                    FilterChip(selected = lang == v, onClick = { update { it.put("language", v) } }, label = { Text(l) })
                }
            }
        }

        Section("Privacy", null) {
            ToggleRow("Keep history in the cloud", "Syncs your dictations to your other devices.", settings.optBoolean("store_history", true)) { on ->
                update { it.put("store_history", on) }
            }
            var haptics by remember { mutableStateOf(app.store.haptics) }
            ToggleRow("Haptics", null, haptics) { haptics = it; app.store.haptics = it }
        }

        Section("Server", "Where your PromptFlow backend runs. Filled in for you in release builds.") {
            var url by remember { mutableStateOf(app.store.serverUrl) }
            var key by remember { mutableStateOf(app.store.anonKey) }
            OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Server URL") }, singleLine = true, shape = RoundedCornerShape(14.dp))
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(key, { key = it }, Modifier.fillMaxWidth(), label = { Text("Public (anon) key") }, singleLine = true, shape = RoundedCornerShape(14.dp))
            TextButton(onClick = { app.store.serverUrl = url; app.store.anonKey = key }) { Text("Save") }
        }
    }
}

@Composable
private fun Section(title: String, subtitle: String?, content: @Composable () -> Unit) {
    Card {
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            subtitle?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun ToggleRow(title: String, body: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            body?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** Email + 6-digit code sign-in, shared by onboarding and Settings. */
@Composable
fun AccountForm(onSignedIn: () -> Unit) {
    val api = PromptFlowApp.instance.api
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        api.authEvents.collect { failure ->
            if (failure == null) onSignedIn() else error = failure
        }
    }

    Column {
        OutlinedTextField(
            email, { email = it }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), shape = RoundedCornerShape(14.dp),
        )
        if (sent) {
            Spacer(Modifier.height(10.dp))
            Text(
                "Check your email on this phone and tap the link. PromptFlow opens signed in.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                code, { code = it.filter(Char::isDigit).take(6) }, Modifier.fillMaxWidth(), label = { Text("Or the code, if your email has one") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), shape = RoundedCornerShape(14.dp),
            )
        }
        error?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(12.dp))
        GradientButton(
            if (!sent) "Email me a sign-in link" else "Sign in with code",
            enabled = !busy && email.contains("@") && (!sent || code.length == 6),
        ) {
            busy = true
            error = null
            scope.launch {
                try {
                    if (!sent) {
                        api.sendCode(email)
                        sent = true
                    } else {
                        api.verifyCode(email, code)
                    }
                } catch (e: Exception) {
                    error = e.message ?: "Couldn't sign in"
                } finally {
                    busy = false
                }
            }
        }
    }
}
