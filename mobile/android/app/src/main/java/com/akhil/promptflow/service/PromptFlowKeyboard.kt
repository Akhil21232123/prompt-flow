package com.akhil.promptflow.service

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.core.AppContext
import com.akhil.promptflow.core.Dictation
import com.akhil.promptflow.core.DictationState
import com.akhil.promptflow.core.Gestures
import com.akhil.promptflow.core.Mode
import com.akhil.promptflow.core.StylePreset
import com.akhil.promptflow.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.sin

/**
 * The PromptFlow keyboard: a voice keyboard that works in every app without
 * Accessibility access (so banking apps don't flag it). Tap the mic for an
 * engineered prompt, double-tap for your style, hold to edit the selection.
 */
class PromptFlowKeyboard : InputMethodService() {
    private val app get() = PromptFlowApp.instance
    private var scope: CoroutineScope? = null
    private lateinit var mic: MicPad
    private lateinit var status: TextView
    private lateinit var chips: LinearLayout
    private var blocked: String? = null
    private var watch: kotlinx.coroutines.Job? = null
    private val density get() = resources.displayMetrics.density

    override fun onCreate() {
        super.onCreate()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    }

    override fun onDestroy() {
        if (app.dictation.isListening) {
            app.dictation.cancel()
            RecordingService.stop(this)
        }
        scope?.cancel()
        super.onDestroy()
    }

    private fun dp(v: Int) = (v * density).toInt()

    override fun onCreateInputView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(INK)
            setPadding(dp(10), dp(10), dp(10), dp(8))
        }
        chips = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        root.addView(HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(chips)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        buildChips()

        mic = MicPad(this, Listener())
        root.addView(mic, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(84)).apply { topMargin = dp(10) })

        status = TextView(this).apply {
            setTextColor(MUTED)
            textSize = 13f
            gravity = Gravity.CENTER
            maxLines = 2
        }
        root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)))

        val keys = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        keys.addView(key("🌐", dp(52)) { switchKeyboard() })
        keys.addView(key("space", 0, weight = 1f) { type(" ") })
        keys.addView(repeatKey("⌫", dp(60)) { deleteBackward() })
        keys.addView(key("⏎", dp(60)) { enter() })
        root.addView(keys, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
        return root
    }

    override fun onStartInputView(info: EditorInfo, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        val variation = info.inputType and InputType.TYPE_MASK_VARIATION
        val isPassword = (info.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT &&
            variation in setOf(
                InputType.TYPE_TEXT_VARIATION_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
                InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            ) || (info.inputType and InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_NUMBER &&
            (info.inputType and InputType.TYPE_NUMBER_VARIATION_PASSWORD) != 0
        blocked = when {
            isPassword -> "Voice is off in password fields. Tap 🌐 to type it."
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
                "Tap here to allow the microphone in PromptFlow."
            app.store.session == null -> "Tap here to sign in to PromptFlow."
            else -> null
        }
        buildChips()
        watch?.cancel()
        watch = scope?.launch { app.dictation.state.collectLatest { render(it) } }
        render(app.dictation.state.value)
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        // Leaving the field mid-recording: drop it rather than type elsewhere.
        if (app.dictation.isListening) {
            app.dictation.cancel()
            RecordingService.stop(this)
        }
        super.onFinishInputView(finishingInput)
    }

    // ------------------------------------------------------------ gestures

    private inner class Listener : MicPad.Listener {
        override fun onTap() {
            if (blocked != null) return openApp()
            val d = app.dictation
            if (d.tap(stop = ::finish, start = ::begin) == Dictation.TapResult.SwitchedToStyle) {
                mic.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            }
        }

        override fun onHoldStart() {
            val d = app.dictation
            if (blocked != null || d.isListening || d.state.value is DictationState.Working) return
            mic.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            begin(Mode.Command)
        }

        override fun onHoldEnd() {
            val d = app.dictation
            if (d.isListening && d.currentMode == Mode.Command) finish()
        }
    }

    private fun begin(mode: Mode) {
        RecordingService.start(this)
        if (app.dictation.start(mode)) mic.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        else RecordingService.stop(this)
    }

    private fun finish() {
        mic.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        RecordingService.stop(this)
        app.dictation.finish(context = ::readContext, deliver = ::insert)
    }

    private fun readContext(): Pair<AppContext?, String?> {
        val ic = currentInputConnection
        val pkg = currentInputEditorInfo?.packageName
        val label = pkg?.let { p ->
            runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(p, 0)).toString() }.getOrNull()
        }
        val before = ic?.getTextBeforeCursor(1500, 0)?.toString()
        val selection = ic?.getSelectedText(0)?.toString()
        return AppContext(name = label, packageName = pkg, surroundingText = before) to selection
    }

    private fun insert(result: com.akhil.promptflow.core.DictationResult) {
        val ic = currentInputConnection ?: return
        val selected = ic.getSelectedText(0)
        val text = if (!selected.isNullOrEmpty()) {
            result.text // replaces the selection
        } else {
            TextInserter.joinable(ic.getTextBeforeCursor(1, 0)?.toString().orEmpty(), result.text)
        }
        ic.commitText(text, 1)
    }

    // ---------------------------------------------------------------- keys

    private fun type(s: String) {
        currentInputConnection?.commitText(s, 1)
    }

    private fun deleteBackward() {
        val ic = currentInputConnection ?: return
        if (!ic.getSelectedText(0).isNullOrEmpty()) ic.commitText("", 1)
        else ic.deleteSurroundingText(1, 0)
    }

    private fun enter() {
        val ic = currentInputConnection ?: return
        val info = currentInputEditorInfo
        val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        val noEnterAction = info?.imeOptions?.and(EditorInfo.IME_FLAG_NO_ENTER_ACTION) != 0
        if (!noEnterAction && action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) {
            ic.performEditorAction(action)
        } else {
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            ic.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        }
    }

    private fun switchKeyboard() {
        if (!switchToNextInputMethod(false)) {
            getSystemService(InputMethodManager::class.java).showInputMethodPicker()
        }
    }

    private fun openApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // ------------------------------------------------------------------ UI

    private fun render(state: DictationState) {
        if (!::mic.isInitialized) return
        mic.update(state, app.store.stylePreset, enabled = blocked == null)
        val style = app.store.stylePreset.label
        status.text = blocked ?: when (state) {
            DictationState.Idle -> "Tap: Prompt · Double-tap: $style · Hold: Edit"
            is DictationState.Listening -> when (state.mode) {
                Mode.Engineer -> "Listening… tap when done. Double-tap for $style."
                Mode.Dictate -> "Listening · $style. Tap when done."
                Mode.Command -> "Say what to change, then let go."
            }
            is DictationState.Working -> when (state.mode) {
                Mode.Engineer -> "Engineering your prompt…"
                Mode.Dictate -> "Writing it ${style.lowercase()}…"
                Mode.Command -> "Editing…"
            }
            is DictationState.Done -> if (state.result.dropped) "Didn't catch anything." else state.result.label
            is DictationState.Failed -> state.message
        }
    }

    private fun buildChips() {
        if (!::chips.isInitialized) return
        chips.removeAllViews()
        val current = app.store.stylePreset
        StylePreset.entries.forEach { p ->
            chips.addView(TextView(this).apply {
                text = p.label
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (p == current) 0xFFFFFFFF.toInt() else MUTED)
                setPadding(dp(14), dp(7), dp(14), dp(7))
                background = GradientDrawable().apply {
                    cornerRadius = dp(50).toFloat()
                    if (p == current) {
                        colors = intArrayOf(VIOLET, PINK)
                        orientation = GradientDrawable.Orientation.TL_BR
                    } else {
                        setColor(SURFACE_HIGH)
                    }
                }
                setOnClickListener {
                    app.store.stylePreset = p
                    it.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                    buildChips()
                    render(app.dictation.state.value)
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(6) })
        }
    }

    private fun keyBackground() = GradientDrawable().apply {
        cornerRadius = dp(9).toFloat()
        setColor(SURFACE_HIGH)
    }

    private fun key(label: String, width: Int, weight: Float = 0f, onClick: () -> Unit) = TextView(this).apply {
        text = label
        textSize = 16f
        gravity = Gravity.CENTER
        setTextColor(0xFFFFFFFF.toInt())
        background = keyBackground()
        layoutParams = LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.MATCH_PARENT, weight).apply { marginEnd = dp(6) }
        setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            onClick()
        }
    }

    /** A key that repeats while held, like delete on any keyboard. */
    @SuppressLint("ClickableViewAccessibility")
    private fun repeatKey(label: String, width: Int, action: () -> Unit) = key(label, width) {}.apply {
        setOnClickListener(null)
        val handler = Handler(Looper.getMainLooper())
        val repeat = object : Runnable {
            override fun run() {
                action()
                handler.postDelayed(this, 70)
            }
        }
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    action()
                    handler.postDelayed(repeat, 400)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> handler.removeCallbacks(repeat)
            }
            true
        }
        contentDescription = "Delete"
    }

    companion object {
        const val INK = 0xFF0B0B12.toInt()
        const val SURFACE_HIGH = 0xFF1E1E2B.toInt()
        const val MUTED = 0xFF9A9AB0.toInt()
        const val VIOLET = 0xFF8B7CFF.toInt()
        const val PINK = 0xFFFF6FB5.toInt()
        const val BLUE = 0xFF4F8BFF.toInt()
        const val AMBER = 0xFFFFB547.toInt()

        /** Is the PromptFlow keyboard turned on in system settings? */
        fun isEnabled(context: Context): Boolean =
            context.getSystemService(InputMethodManager::class.java).enabledInputMethodList
                .any { it.packageName == context.packageName }
    }
}

/** The big mic: gradient pill with live voice bars. Tap, or hold. */
@SuppressLint("ViewConstructor")
class MicPad(context: Context, private val listener: Listener) : View(context) {
    interface Listener {
        fun onTap()
        fun onHoldStart()
        fun onHoldEnd()
    }

    private val density = resources.displayMetrics.density
    private var state: DictationState = DictationState.Idle
    private var style = StylePreset.Clean
    private var enabledLook = true
    private var level = 0f
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt()
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }
    private val rect = RectF()
    private val start = System.currentTimeMillis()

    init {
        isClickable = true
        contentDescription = "Dictate. Tap for a prompt, double-tap for your style, hold to edit."
    }

    fun update(s: DictationState, preset: StylePreset, enabled: Boolean) {
        state = s
        style = preset
        enabledLook = enabled
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val mode = when (val s = state) {
            is DictationState.Listening -> s.mode
            is DictationState.Working -> s.mode
            else -> Mode.Engineer
        }
        val (a, b) = when (mode) {
            Mode.Engineer -> PromptFlowKeyboard.VIOLET to PromptFlowKeyboard.BLUE
            Mode.Dictate -> PromptFlowKeyboard.VIOLET to PromptFlowKeyboard.PINK
            Mode.Command -> PromptFlowKeyboard.AMBER to PromptFlowKeyboard.PINK
        }
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        fill.shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), a, b, Shader.TileMode.CLAMP)
        fill.alpha = if (enabledLook) 255 else 110
        canvas.drawRoundRect(rect, height / 2f, height / 2f, fill)

        val cy = height / 2f
        val t = (System.currentTimeMillis() - start) / 1000f
        when (val s = state) {
            is DictationState.Listening -> {
                level += (s.level - level) * 0.35f
                val bars = 7
                val gap = 7 * density
                val w = 5 * density
                val total = bars * w + (bars - 1) * gap
                var x = width / 2f - total / 2f - 40 * density
                for (i in 0 until bars) {
                    val wave = 0.35f + 0.65f * abs(sin(t * 6 + i * 0.9f))
                    val h = (8 * density + level * 46 * density * wave).coerceAtMost(height * 0.7f)
                    canvas.drawRoundRect(x, cy - h / 2, x + w, cy + h / 2, w, w, bar)
                    x += w + gap
                }
                text.textSize = 14 * density
                val label = when (s.mode) {
                    Mode.Engineer -> "Prompt"
                    Mode.Dictate -> style.label
                    Mode.Command -> "Edit"
                }
                canvas.drawText(label, width / 2f + total / 2f + 10 * density, cy + 5 * density, text)
                postInvalidateOnAnimation()
            }
            is DictationState.Working -> {
                val r = 12 * density
                val sweep = (t * 360f) % 360f
                bar.style = Paint.Style.STROKE
                bar.strokeWidth = 3 * density
                canvas.drawArc(width / 2f - r, cy - r, width / 2f + r, cy + r, sweep, 110f, false, bar)
                bar.style = Paint.Style.FILL
                postInvalidateOnAnimation()
            }
            is DictationState.Done -> {
                text.textSize = 22 * density
                canvas.drawText("✓", width / 2f, cy + 8 * density, text)
            }
            else -> {
                text.textSize = 17 * density
                canvas.drawText("🎙  Tap: Prompt", width / 2f, cy - 2 * density, text)
                text.textSize = 12 * density
                text.alpha = 220
                canvas.drawText("Double-tap: ${style.label} · Hold: Edit", width / 2f, cy + 18 * density, text)
                text.alpha = 255
            }
        }
    }

    private var holding = false
    private val hold = Runnable {
        holding = true
        listener.onHoldStart()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                holding = false
                scaleX = 0.97f; scaleY = 0.97f
                postDelayed(hold, Gestures.HOLD_MS)
            }
            MotionEvent.ACTION_UP -> {
                scaleX = 1f; scaleY = 1f
                removeCallbacks(hold)
                if (holding) listener.onHoldEnd() else listener.onTap()
                holding = false
            }
            MotionEvent.ACTION_CANCEL -> {
                scaleX = 1f; scaleY = 1f
                removeCallbacks(hold)
                if (holding) listener.onHoldEnd()
                holding = false
            }
        }
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        listener.onTap()
        return true
    }
}
