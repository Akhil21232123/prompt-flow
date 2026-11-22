package com.akhil.promptflow.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** What the bubble and the app show. */
sealed interface DictationState {
    data object Idle : DictationState
    data class Listening(val mode: Mode, val level: Float, val startedAt: Long) : DictationState
    data class Working(val mode: Mode) : DictationState
    data class Done(val result: DictationResult) : DictationState
    data class Failed(val message: String, val needsSignIn: Boolean = false) : DictationState
}

/**
 * One dictation at a time, shared by the floating bubble and the in-app
 * dictation pad: record → send to the backend → hand the text to [deliver].
 */
class Dictation(private val api: Api, private val store: Store) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state.asStateFlow()

    private var mode = Mode.Dictate
    private var startedAt = 0L
    private var job: Job? = null
    private val recorder = Recorder { level ->
        val s = _state.value
        if (s is DictationState.Listening) _state.value = s.copy(level = level)
    }

    val isListening get() = _state.value is DictationState.Listening

    fun start(mode: Mode): Boolean {
        if (isListening) return true
        job?.cancel()
        this.mode = mode
        if (!recorder.start()) {
            fail("The microphone is busy or not allowed")
            return false
        }
        startedAt = System.currentTimeMillis()
        _state.value = DictationState.Listening(mode, 0f, startedAt)
        return true
    }

    /**
     * Stops recording and processes it. [context] is read at stop time so a
     * Command Mode selection is current.
     */
    fun finish(context: () -> Pair<AppContext?, String?>, deliver: (DictationResult) -> Unit) {
        if (!isListening) return
        val (wav, seconds) = recorder.stop()
        if (seconds < 0.35) {
            _state.value = DictationState.Idle
            return
        }
        val m = mode
        _state.value = DictationState.Working(m)
        job = scope.launch {
            try {
                val (app, selection) = context()
                val result = api.dictate(wav, m, app, if (m == Mode.Command) selection else null, seconds)
                if (result.text.isNotBlank()) {
                    deliver(result)
                    store.addHistory(
                        HistoryItem(System.currentTimeMillis(), app?.name ?: app?.packageName ?: "", result.mode, result.raw, result.text, result.label),
                    )
                    store.wordsDictated = store.wordsDictated + result.raw.wordCount()
                }
                _state.value = DictationState.Done(result)
                delay(1400)
                if (_state.value is DictationState.Done) _state.value = DictationState.Idle
            } catch (e: ApiException) {
                fail(e.message ?: "Something went wrong", e.status == 401 || e.code == "auth" || e.code == "config")
            } catch (e: Exception) {
                fail("Couldn't reach PromptFlow. Check your connection.")
            }
        }
    }

    fun cancel() {
        if (isListening) recorder.cancel()
        job?.cancel()
        _state.value = DictationState.Idle
    }

    private fun fail(message: String, needsSignIn: Boolean = false) {
        _state.value = DictationState.Failed(message, needsSignIn)
        scope.launch {
            delay(3500)
            if (_state.value is DictationState.Failed) _state.value = DictationState.Idle
        }
    }
}
