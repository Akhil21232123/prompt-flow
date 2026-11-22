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
import com.akhil.promptflow.ui.components.StylePicker
import com.akhil.promptflow.core.StylePreset
import com.akhil.promptflow.core.Dictation
import com.akhil.promptflow.ui.components.Orb
import com.akhil.promptflow.ui.components.Stat

@Composable
fun HomeScreen() {
    val app = PromptFlowApp.instance
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val state by app.dictation.state.collectAsState()
    var style by remember { mutableStateOf(app.store.stylePreset) }
    var pad by rememberSaveable { mutableStateOf("") }
    var bubbleOn by remember { mutableStateOf(Sys.bubbleEnabled(context)) }
    var keyboardOn by remember { mutableStateOf(Sys.keyboardEnabled(context)) }
    // Re-check whenever the user comes back (e.g. from Accessibility settings).
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(owner) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e ->
            if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                bubbleOn = Sys.bubbleEnabled(context)
                keyboardOn = Sys.keyboardEnabled(context)
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    val d = app.dictation
    fun ctx() = AppContext(name = "PromptFlow", packageName = context.packageName) to pad.ifBlank { null }
    val deliver: (com.akhil.promptflow.core.DictationResult) -> Unit = { r ->
        pad = if (r.mode == Mode.Command) r.text else listOf(pad, r.text).filter { it.isNotBlank() }.joinToString(" ")
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("PromptFlow", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        StylePicker(style) { style = it; app.store.stylePreset = it }
        Text(
            "Double-tap style: ${style.hint}",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
        )
        Spacer(Modifier.height(8.dp))
        val orbMode = (state as? DictationState.Listening)?.mode ?: (state as? DictationState.Working)?.mode ?: Mode.Engineer
        Orb(
            state, orbMode,
            onHoldStart = {
                if (!d.isListening && state !is DictationState.Working) {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    d.start(Mode.Command)
                }
            },
            onHoldEnd = { if (d.isListening && d.currentMode == Mode.Command) d.finish(::ctx, deliver) },
        ) {
            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            d.tap(stop = { d.finish(::ctx, deliver) }, start = { d.start(it) })
        }
        StatusLine(state, style)
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = pad,
            onValueChange = { pad = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
            placeholder = { Text("Try it here: tap the orb and talk.") },
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
                if (keyboardOn) {
                    Text("● Keyboard is on", style = MaterialTheme.typography.titleMedium, color = androidx.compose.ui.graphics.Color(0xFF4ADE80))
                    Text(
                        "In any app, tap a text box, then switch to PromptFlow with your keyboard's switch button (or below).",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { Sys.showKeyboardPicker(context) }) { Text("Switch keyboard now") }
                } else {
                    Text("Turn on the PromptFlow keyboard", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "It's how you dictate into WhatsApp, Gmail, ChatGPT and every other app. Turn on \"PromptFlow voice keyboard\" in the list that opens.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = { Sys.openKeyboardSettings(context) }) { Text("Open keyboard settings") }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        Card {
            Column {
                Text("Floating bubble (optional)", style = MaterialTheme.typography.titleMedium)
                Text(
                    if (bubbleOn) "On. It hides itself in payment and banking apps, but some of them still warn while it's switched on. Turn it off in Accessibility if that bothers you."
                    else "A bubble over your usual keyboard instead. It needs Accessibility access, which banking apps like GPay warn about, so the keyboard is the better choice.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { Sys.openAccessibilitySettings(context) }) { Text(if (bubbleOn) "Accessibility settings" else "Turn on the bubble") }
            }
        }
        Spacer(Modifier.height(12.dp))
        Card {
            Column {
                Text("How it works", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Tap the mic, talk, tap again: you get a prompt engineered for the best answer.\n" +
                        "Double-tap: your words in the style you picked above, never turned into a prompt.\n" +
                        "Hold: say how to change the selected text, then let go.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun StatusLine(state: DictationState, style: StylePreset) {
    val text = when (state) {
        DictationState.Idle -> "Tap: Prompt · Double-tap: ${style.label} · Hold: edit the text below"
        is DictationState.Listening -> when (state.mode) {
            Mode.Engineer -> "Listening for a prompt… double-tap for ${style.label}"
            Mode.Dictate -> "Listening · ${style.label}"
            Mode.Command -> "Say what to change, then let go."
        }
        is DictationState.Working -> when (state.mode) {
            Mode.Engineer -> "Engineering your prompt…"
            Mode.Dictate -> "Writing it ${style.label.lowercase()}…"
            Mode.Command -> "Editing…"
        }
        is DictationState.Done -> if (state.result.dropped) "Didn't catch anything" else "${state.result.label} · ${state.result.totalMs} ms"
        is DictationState.Failed -> state.message
    }
    AnimatedContent(text, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "status") {
        Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}
