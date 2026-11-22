package com.akhil.promptflow.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.core.DictionaryWord
import com.akhil.promptflow.core.Snippet
import com.akhil.promptflow.ui.components.Card
import kotlinx.coroutines.launch

@Composable
fun WordsScreen() {
    var tab by remember { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Text("Words", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("Dictionary", "Snippets").forEachIndexed { i, label ->
                SegmentedButton(
                    selected = tab == i,
                    onClick = { tab = i },
                    shape = SegmentedButtonDefaults.itemShape(i, 2),
                ) { Text(label) }
            }
        }
        Spacer(Modifier.height(16.dp))
        if (tab == 0) DictionaryList() else SnippetList()
    }
}

@Composable
private fun DictionaryList() {
    val api = PromptFlowApp.instance.api
    val scope = rememberCoroutineScope()
    var words by remember { mutableStateOf<List<DictionaryWord>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun reload() {
        error = runCatching { words = api.dictionary() }.exceptionOrNull()?.message
    }
    LaunchedEffect(Unit) { reload() }

    Text(
        "Names and terms PromptFlow should always spell right. It also learns them when you fix a word it got wrong.",
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(draft, { draft = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text("Add a word") }, shape = RoundedCornerShape(14.dp))
        Spacer(Modifier.width(8.dp))
        TextButton(enabled = draft.isNotBlank(), onClick = {
            val w = draft
            draft = ""
            scope.launch { error = runCatching { api.addWord(w) }.exceptionOrNull()?.message; reload() }
        }) { Text("Add") }
    }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
        items(words, key = { it.id }) { w ->
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(w.word, style = MaterialTheme.typography.titleMedium)
                        if (w.source == "learned") Text("Learned from your edits", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    }
                    IconButton(onClick = { scope.launch { runCatching { api.deleteWord(w.id) }; reload() } }) {
                        Icon(Icons.Rounded.Close, contentDescription = "Remove ${w.word}")
                    }
                }
            }
        }
    }
}

@Composable
private fun SnippetList() {
    val api = PromptFlowApp.instance.api
    val scope = rememberCoroutineScope()
    var snippets by remember { mutableStateOf<List<Snippet>>(emptyList()) }
    var trigger by remember { mutableStateOf("") }
    var expansion by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun reload() {
        error = runCatching { snippets = api.snippets() }.exceptionOrNull()?.message
    }
    LaunchedEffect(Unit) { reload() }

    Text("Say the trigger, get the text. Links and addresses are never reworded.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(trigger, { trigger = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("Trigger, e.g. my calendly link") }, shape = RoundedCornerShape(14.dp))
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(expansion, { expansion = it }, Modifier.fillMaxWidth(), placeholder = { Text("Text to insert") }, shape = RoundedCornerShape(14.dp))
    TextButton(enabled = trigger.isNotBlank() && expansion.isNotBlank(), onClick = {
        val t = trigger
        val e = expansion
        trigger = ""
        expansion = ""
        scope.launch { error = runCatching { api.saveSnippet(t, e) }.exceptionOrNull()?.message; reload() }
    }) { Text("Save snippet") }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(snippets, key = { it.id }) { s ->
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("“${s.trigger}”", style = MaterialTheme.typography.titleMedium)
                        Text(s.expansion, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                    }
                    IconButton(onClick = { scope.launch { runCatching { api.deleteSnippet(s.id) }; reload() } }) {
                        Icon(Icons.Rounded.Close, contentDescription = "Remove snippet")
                    }
                }
            }
        }
    }
}
