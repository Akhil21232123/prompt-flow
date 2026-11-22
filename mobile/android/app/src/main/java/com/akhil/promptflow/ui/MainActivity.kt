package com.akhil.promptflow.ui

import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.MenuBook
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.ui.screens.HistoryScreen
import com.akhil.promptflow.ui.screens.HomeScreen
import com.akhil.promptflow.ui.screens.OnboardingScreen
import com.akhil.promptflow.ui.screens.SettingsScreen
import com.akhil.promptflow.ui.screens.WordsScreen
import com.akhil.promptflow.ui.theme.PromptFlowTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = application as PromptFlowApp
        handleLink(intent)
        setContent {
            PromptFlowTheme {
                var onboarded by remember { mutableStateOf(app.store.onboarded) }
                AnimatedContent(onboarded, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "root") { done ->
                    if (done) MainScaffold() else OnboardingScreen(onFinished = {
                        app.store.onboarded = true
                        onboarded = true
                    })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    /** promptflow://auth#… from the sign-in email. */
    private fun handleLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "promptflow" || uri.host != "auth") return
        val app = application as PromptFlowApp
        lifecycleScope.launch { runCatching { app.api.completeLink(uri.toString()) } }
        intent.data = null
    }
}

private data class Tab(val label: String, val icon: ImageVector)

private val TABS = listOf(
    Tab("Flow", Icons.Rounded.GraphicEq),
    Tab("History", Icons.Rounded.History),
    Tab("Words", Icons.Rounded.MenuBook),
    Tab("Settings", Icons.Rounded.Tune),
)

@Composable
private fun MainScaffold() {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                TABS.forEachIndexed { i, t ->
                    NavigationBarItem(
                        selected = tab == i,
                        onClick = { tab = i },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.surfaceVariant),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            AnimatedContent(tab, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "tab") { i ->
                when (i) {
                    0 -> HomeScreen()
                    1 -> HistoryScreen()
                    2 -> WordsScreen()
                    else -> SettingsScreen()
                }
            }
        }
    }
}
