package com.akhil.promptflow.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.text.format.DateUtils
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.core.HistoryItem
import com.akhil.promptflow.ui.components.Card

@Composable
fun HistoryScreen() {
    val app = PromptFlowApp.instance
    var items by remember { mutableStateOf(app.store.history()) }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("History", style = MaterialTheme.typography.headlineSmall)
            if (items.isNotEmpty()) TextButton(onClick = { app.store.clearHistory(); items = emptyList() }) { Text("Clear") }
        }
        if (items.isEmpty()) {
            Spacer(Modifier.height(40.dp))
            Text("Your dictations show up here, with what you said next to what PromptFlow wrote.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 12.dp)) {
            items(items, key = { it.at }) { HistoryRow(it) }
        }
    }
}

@Composable
private fun HistoryRow(item: HistoryItem) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    Card(Modifier.animateContentSize().clickable { open = !open }) {
        Column {
            Text(
                listOf(item.app.ifBlank { "PromptFlow" }, item.mode.label, DateUtils.getRelativeTimeSpanString(item.at).toString()).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            Text(item.text, maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
            if (open) {
                Spacer(Modifier.height(10.dp))
                Text("You said", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                Text(item.raw, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (item.label.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(item.label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = {
                    context.getSystemService(ClipboardManager::class.java)
                        ?.setPrimaryClip(ClipData.newPlainText("PromptFlow", item.text))
                }) { Text("Copy") }
            }
        }
    }
}
