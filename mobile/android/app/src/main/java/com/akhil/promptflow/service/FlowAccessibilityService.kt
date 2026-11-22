package com.akhil.promptflow.service

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.akhil.promptflow.PromptFlowApp
import com.akhil.promptflow.core.AppContext
import com.akhil.promptflow.core.DictationState
import com.akhil.promptflow.core.Mode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Shows the PromptFlow bubble whenever a text field is focused in any app,
 * and types the result into that field. Works alongside whatever keyboard
 * the user already has.
 *
 * Tap: dictate. Long-press: Prompt Engineer. Double-tap: Command Mode on the
 * selected text. Drag: move the bubble (it snaps to the nearest edge).
 */
class FlowAccessibilityService : AccessibilityService(), BubbleView.Listener {

    private val app get() = PromptFlowApp.instance
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private var bubble: BubbleView? = null
    private var params: WindowManager.LayoutParams? = null

    /** The field the bubble is attached to. */
    private var target: AccessibilityNodeInfo? = null
    private var targetPackage: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        wm = getSystemService(WindowManager::class.java)
        scope.launch {
            app.dictation.state.collect { render(it) }
        }
    }

    override fun onDestroy() {
        removeBubble()
        scope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // Keep the bubble on screen while a dictation is in flight, even if
        // focus flickers.
        if (app.dictation.state.value !is DictationState.Idle) return
        val focused = findFocusedEditable()
        if (focused != null && !focused.isPassword) {
            target = focused
            targetPackage = focused.packageName?.toString() ?: event.packageName?.toString()
            showBubble()
        } else if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED
        ) {
            if (focused == null || focused.isPassword) hideBubbleSoon()
        }
    }

    private fun findFocusedEditable(): AccessibilityNodeInfo? {
        val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        return if (node.isEditable) node else null
    }

    // ----------------------------------------------------------- bubble UI

    private val hideRunnable = Runnable { removeBubble() }

    private fun hideBubbleSoon() {
        main.removeCallbacks(hideRunnable)
        main.postDelayed(hideRunnable, 700)
    }

    private fun showBubble() {
        main.removeCallbacks(hideRunnable)
        if (bubble != null) return
        val view = BubbleView(this, this)
        val metrics = resources.displayMetrics
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val size = (56 * metrics.density).toInt()
            x = if (app.store.bubbleOnRight) metrics.widthPixels - size - (6 * metrics.density).toInt() else (6 * metrics.density).toInt()
            y = app.store.bubbleY.takeIf { it >= 0 } ?: (metrics.heightPixels * 0.42f).toInt()
        }
        runCatching {
            wm.addView(view, lp)
            view.alpha = 0f
            view.scaleX = 0.6f
            view.scaleY = 0.6f
            view.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180).start()
            bubble = view
            params = lp
        }
    }

    private fun removeBubble() {
        val view = bubble ?: return
        bubble = null
        view.animate().alpha(0f).scaleX(0.6f).scaleY(0.6f).setDuration(140).withEndAction {
            runCatching { wm.removeView(view) }
        }.start()
    }

    private fun render(state: DictationState) {
        val view = bubble ?: return
        when (state) {
            DictationState.Idle -> {
                view.look = BubbleView.Look.Idle
                view.mode = Mode.Dictate
            }
            is DictationState.Listening -> {
                view.look = BubbleView.Look.Listening
                view.mode = state.mode
                view.level = state.level
            }
            is DictationState.Working -> view.look = BubbleView.Look.Working
            is DictationState.Done -> view.look = BubbleView.Look.Done
            is DictationState.Failed -> {
                view.look = BubbleView.Look.Error
                android.widget.Toast.makeText(this, state.message, android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ----------------------------------------------------------- gestures

    override fun onTap() = toggle(Mode.Dictate)
    override fun onLongPress() = toggle(Mode.Engineer)
    override fun onDoubleTap() = toggle(Mode.Command)

    private fun toggle(mode: Mode) {
        val d = app.dictation
        if (d.isListening) {
            haptic()
            RecordingService.stop(this)
            d.finish(context = ::readContext, deliver = { result ->
                val node = target ?: findFocusedEditable()
                if (node != null) TextInserter.insert(this, node, result.text)
            })
            return
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            android.widget.Toast.makeText(this, "Open PromptFlow to allow the microphone", android.widget.Toast.LENGTH_LONG).show()
            return
        }
        RecordingService.start(this)
        if (d.start(mode)) haptic() else RecordingService.stop(this)
    }

    private fun readContext(): Pair<AppContext?, String?> {
        val node = target?.also { it.refresh() }
        val pkg = targetPackage
        val label = pkg?.let { p ->
            runCatching { packageManager.getApplicationLabel(packageManager.getApplicationInfo(p, 0)).toString() }.getOrNull()
        }
        val ctx = AppContext(name = label, packageName = pkg, surroundingText = node?.let { TextInserter.before(it) })
        return ctx to node?.let { TextInserter.selection(it) }
    }

    private fun haptic() {
        if (app.store.haptics) bubble?.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
    }

    override fun onDragged(dx: Float, dy: Float) {
        val lp = params ?: return
        val view = bubble ?: return
        lp.x += dx.toInt()
        lp.y += dy.toInt()
        runCatching { wm.updateViewLayout(view, lp) }
    }

    override fun onDragEnd() {
        val lp = params ?: return
        val view = bubble ?: return
        val metrics = resources.displayMetrics
        val onRight = lp.x + view.width / 2 > metrics.widthPixels / 2
        val margin = (6 * metrics.density).toInt()
        val targetX = if (onRight) metrics.widthPixels - view.width - margin else margin
        app.store.bubbleOnRight = onRight
        app.store.bubbleY = lp.y
        // Spring to the edge.
        val startX = lp.x
        android.animation.ValueAnimator.ofInt(startX, targetX).apply {
            duration = 260
            interpolator = android.view.animation.OvershootInterpolator(1.2f)
            addUpdateListener {
                lp.x = it.animatedValue as Int
                runCatching { wm.updateViewLayout(view, lp) }
            }
            start()
        }
    }
}
