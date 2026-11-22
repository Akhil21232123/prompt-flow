package com.akhil.promptflow.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.unit.dp
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.core.AppContext
import com.akhil.promptflow.core.DictationState
import com.akhil.promptflow.core.Mode
import com.akhil.promptflow.ui.components.Card
import com.akhil.promptflow.ui.components.ModeSwitch
import com.akhil.promptflow.ui.components.Orb
import com.akhil.promptflow.ui.components.Stat

@Composable
fun HomeScreen() {
    val app = PromptFlowApp.instance
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val state by app.dictation.state.collectAsState()
    var mode by rememberSaveable { mutableStateOf(Mode.Dictate) }
    var pad by rememberSaveable { mutableStateOf("") }
    var bubbleOn by remember { mutableStateOf(Sys.bubbleEnabled(context)) }
    // Re-check whenever the user comes back (e.g. from Accessibility settings).
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(owner) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e ->
            if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) bubbleOn = Sys.bubbleEnabled(context)
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("PromptFlow", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        ModeSwitch(mode) { mode = it }
        Spacer(Modifier.height(8.dp))
        Orb(state, mode) {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            if (app.dictation.isListening) {
                app.dictation.finish(
                    context = { AppContext(name = "PromptFlow", packageName = context.packageName) to pad.ifBlank { null } },
                    deliver = { r -> pad = if (mode == Mode.Command) r.text else listOf(pad, r.text).filter { it.isNotBlank() }.joinToString(" ") },
                )
            } else {
                app.dictation.start(mode)
            }
        }
        StatusLine(state, mode)
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = pad,
            onValueChange = { pad = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
            placeholder = { Text("Try it here: tap the orb and talk. Or tap this field and use the bubble.") },
            shape = RoundedCornerShape(18.dp),
        )
        if (pad.isNotBlank()) TextButton(onClick = { pad = "" }) { Text("Clear") }
        Spacer(Modifier.height(16.dp))
        Card {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                val words = app.store.wordsDictated
                Stat("%,d".format(words), "words dictated")
                // Typing ~40 wpm vs speaking ~150 wpm.
                Stat("${(words / 40.0 - words / 150.0).toInt()} min", "saved vs typing")
            }
        }
        Spacer(Modifier.height(12.dp))
        Card {
            Column {
                if (bubbleOn) {
                    Text("● Bubble is on", style = MaterialTheme.typography.titleMedium, color = androidx.compose.ui.graphics.Color(0xFF4ADE80))
                    Text(
                        "Open any app and tap a text box: the bubble appears just above your keyboard.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text("Turn on the bubble", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "It's what lets you dictate into WhatsApp, Gmail, ChatGPT and every other app. " +
                            "Settings → Accessibility → Installed apps → PromptFlow → On.\n\n" +
                            "Greyed out? Settings → Apps → PromptFlow → ⋮ → Allow restricted settings, then try again.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { Sys.openAccessibilitySettings(context) }) { Text("Open Accessibility settings") }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Card {
            Column {
                Text("Using the bubble", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text("Tap: dictate · Hold: Prompt Engineer · Double-tap: edit selected text · Drag: move", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun StatusLine(state: DictationState, mode: Mode) {
    val text = when (state) {
        DictationState.Idle -> when (mode) {
            Mode.Dictate -> "Tap and talk. Tap again when you're done."
            Mode.Engineer -> "Ramble your request. You'll get a prompt built to get the best answer."
            Mode.Command -> "Say what to change about the text below."
        }
        is DictationState.Listening -> "Listening…"
        is DictationState.Working -> if (state.mode == Mode.Engineer) "Engineering your prompt…" else "Polishing…"
        is DictationState.Done -> if (state.result.dropped) "Didn't catch anything" else "${state.result.label} · ${state.result.totalMs} ms"
        is DictationState.Failed -> state.message
    }
    AnimatedContent(text, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "status") {
        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}
