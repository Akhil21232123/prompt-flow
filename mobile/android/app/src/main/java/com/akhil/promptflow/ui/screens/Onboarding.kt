package com.akhil.promptflow.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.akhil.promptflow.core.DictationState
import com.akhil.promptflow.core.Mode
import com.akhil.promptflow.ui.components.GradientButton
import com.akhil.promptflow.ui.components.Orb

@Composable
fun OnboardingScreen(onFinished: () -> Unit) {
    var step by remember { mutableIntStateOf(0) }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AnimatedContent(
            step,
            transitionSpec = { slideInHorizontally { it } togetherWith slideOutHorizontally { -it } },
            label = "step",
            modifier = Modifier.weight(1f),
        ) { s ->
            when (s) {
                0 -> Welcome { step = 1 }
                1 -> Permissions { step = 2 }
                else -> SignIn(onDone = onFinished, onSkip = onFinished)
            }
        }
    }
}

@Composable
private fun Welcome(next: () -> Unit) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Orb(DictationState.Idle, Mode.Dictate, onClick = next)
        Spacer(Modifier.height(32.dp))
        Text("PromptFlow", style = MaterialTheme.typography.displaySmall)
        Spacer(Modifier.height(12.dp))
        Text(
            "Speak anywhere you can type. Clean text in messages, and prompts that get more out of every AI.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(40.dp))
        GradientButton("Get started", onClick = next)
    }
}

@Composable
private fun Permissions(next: () -> Unit) {
    val context = LocalContext.current
    var mic by remember { mutableStateOf(Sys.hasMic(context)) }
    var bubble by remember { mutableStateOf(Sys.bubbleEnabled(context)) }
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { mic = it }
    val notifLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // Re-check when the user comes back from Settings.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) {
                mic = Sys.hasMic(context)
                bubble = Sys.bubbleEnabled(context)
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        Text("Two quick permissions", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "PromptFlow only listens while the bubble is lit, and shows a notification whenever it does.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(28.dp))
        PermissionRow(
            title = "Microphone",
            body = "To hear what you say.",
            granted = mic,
        ) {
            micLauncher.launch(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        Spacer(Modifier.height(16.dp))
        PermissionRow(
            title = "PromptFlow bubble",
            body = "Settings → Accessibility → PromptFlow bubble → On. It shows the bubble next to text fields and types your words in. Password fields are skipped.",
            granted = bubble,
        ) { Sys.openAccessibilitySettings(context) }
        Spacer(Modifier.height(36.dp))
        GradientButton(if (mic && bubble) "Continue" else "Continue anyway", onClick = next)
    }
}

@Composable
private fun PermissionRow(title: String, body: String, granted: Boolean, onClick: () -> Unit) {
    com.akhil.promptflow.ui.components.Card {
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(10.dp))
            if (granted) Text("✓ Allowed", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
            else TextButton(onClick = onClick) { Text("Allow") }
        }
    }
}

@Composable
private fun SignIn(onDone: () -> Unit, onSkip: () -> Unit) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        Text("Sign in", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "Your dictionary, snippets and styles sync across your phone and Mac.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        AccountForm(onSignedIn = onDone)
        Spacer(Modifier.height(12.dp))
        TextButton(onClick = onSkip, modifier = Modifier.fillMaxWidth()) { Text("Later") }
    }
}
