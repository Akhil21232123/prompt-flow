package com.akhil.promptflow.service

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import android.view.animation.LinearInterpolator
import com.akhil.promptflow.core.Mode
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

/**
 * The floating bubble, drawn by hand so it animates at 60 fps without
 * Compose inside an overlay window.
 *
 * Idle: a small glowing pill. Listening: live waveform bars with a ring that
 * breathes with your voice. Working: an orbiting arc. Done: a check.
 */
@SuppressLint("ViewConstructor")
class BubbleView(context: Context, private val listener: Listener) : View(context) {

    interface Listener {
        fun onTap()
        fun onLongPress()
        fun onDoubleTap()
        fun onDragged(dx: Float, dy: Float)
        fun onDragEnd()
    }

    enum class Look { Idle, Listening, Working, Done, Error }

    private val density = resources.displayMetrics.density
    private val sizePx = (56 * density).toInt()

    var look: Look = Look.Idle
        set(v) {
            if (field != v) {
                field = v
                invalidate()
            }
        }
    var mode: Mode = Mode.Dictate
        set(v) {
            field = v
            invalidate()
        }
    var level: Float = 0f
        set(v) {
            field = field * 0.6f + v * 0.4f // smooth jitter
            invalidate()
        }

    private var phase = 0f
    private val ticker = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1600
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            phase = it.animatedValue as Float
            if (look != Look.Idle) invalidate()
        }
    }

    private val bg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f * density
        strokeCap = Paint.Cap.ROUND
    }
    private val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt() }
    private val badge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt()
        textAlign = Paint.Align.CENTER
        textSize = 9 * density
        isFakeBoldText = true
    }
    private val rect = RectF()

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ticker.start()
    }

    override fun onDetachedFromWindow() {
        ticker.cancel()
        super.onDetachedFromWindow()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(sizePx, sizePx)
    }

    private fun accent(): Pair<Int, Int> = when {
        look == Look.Error -> 0xFFFF5A6A.toInt() to 0xFFB3261E.toInt()
        mode == Mode.Engineer -> 0xFF8B7CFF.toInt() to 0xFF4F8BFF.toInt()
        mode == Mode.Command -> 0xFFFFB547.toInt() to 0xFFFF6FB5.toInt()
        else -> 0xFF8B7CFF.toInt() to 0xFFFF6FB5.toInt()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2
        val cy = h / 2
        val (c1, c2) = accent()
        val breathing = if (look == Look.Listening) 1f + level * 0.12f else 1f
        val r = (if (look == Look.Idle) w * 0.34f else w * 0.42f) * breathing

        bg.shader = LinearGradient(cx - r, cy - r, cx + r, cy + r, c1, c2, Shader.TileMode.CLAMP)
        bg.alpha = if (look == Look.Idle) 215 else 255
        canvas.drawCircle(cx, cy, r, bg)

        when (look) {
            Look.Idle -> drawBars(canvas, cx, cy, r * 0.55f, 0.35f, still = true)
            Look.Listening -> {
                ring.color = c2
                ring.alpha = (90 + 120 * level).toInt().coerceAtMost(255)
                canvas.drawCircle(cx, cy, r + 4 * density + level * 6 * density, ring)
                drawBars(canvas, cx, cy, r * 0.6f, 0.25f + level, still = false)
            }
            Look.Working -> {
                ring.color = 0xFFFFFFFF.toInt()
                ring.alpha = 230
                rect.set(cx - r * 0.55f, cy - r * 0.55f, cx + r * 0.55f, cy + r * 0.55f)
                canvas.drawArc(rect, phase * 360f, 100f, false, ring)
            }
            Look.Done -> {
                ring.color = 0xFFFFFFFF.toInt()
                ring.alpha = 255
                val s = r * 0.42f
                canvas.drawLine(cx - s, cy, cx - s * 0.25f, cy + s * 0.7f, ring)
                canvas.drawLine(cx - s * 0.25f, cy + s * 0.7f, cx + s, cy - s * 0.6f, ring)
            }
            Look.Error -> {
                ring.color = 0xFFFFFFFF.toInt()
                val s = r * 0.35f
                canvas.drawLine(cx - s, cy - s, cx + s, cy + s, ring)
                canvas.drawLine(cx + s, cy - s, cx - s, cy + s, ring)
            }
        }

        // Mode badge, so a long-press visibly switches to Prompt Engineer.
        if (mode != Mode.Dictate && look != Look.Idle) {
            canvas.drawText(if (mode == Mode.Engineer) "PROMPT" else "EDIT", cx, h - 2 * density, badge)
        }
    }

    private fun drawBars(canvas: Canvas, cx: Float, cy: Float, span: Float, amp: Float, still: Boolean) {
        val count = 5
        val gap = span * 2 / (count * 2 - 1)
        for (i in 0 until count) {
            val x = cx - span + gap * (i * 2) + gap / 2
            val wave = if (still) 1f - 0.25f * abs(2 - i)
            else 0.35f + 0.65f * abs(sin((phase * 2 * PI + i * 0.9).toFloat()))
            val half = (span * 0.9f * wave * amp.coerceIn(0.2f, 1f)).coerceAtLeast(gap * 0.6f)
            rect.set(x - gap / 2, cy - half, x + gap / 2, cy + half)
            canvas.drawRoundRect(rect, gap / 2, gap / 2, bar)
        }
    }

    // ------------------------------------------------------------- gestures

    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var dragging = false
    private var longPressed = false
    private var lastTapAt = 0L
    private val longPress = Runnable {
        if (!dragging) {
            longPressed = true
            performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            listener.onLongPress()
        }
    }
    private val singleTap = Runnable { listener.onTap() }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        val slop = 8 * density
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.rawX; downY = e.rawY; lastX = e.rawX; lastY = e.rawY
                dragging = false
                longPressed = false
                postDelayed(longPress, 450)
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) {
                    dragging = true
                    removeCallbacks(longPress)
                }
                if (dragging) {
                    listener.onDragged(e.rawX - lastX, e.rawY - lastY)
                    lastX = e.rawX; lastY = e.rawY
                }
            }
            MotionEvent.ACTION_UP -> {
                removeCallbacks(longPress)
                when {
                    dragging -> listener.onDragEnd()
                    longPressed -> Unit
                    else -> {
                        val now = System.currentTimeMillis()
                        if (now - lastTapAt < 280) {
                            removeCallbacks(singleTap)
                            lastTapAt = 0
                            listener.onDoubleTap()
                        } else {
                            lastTapAt = now
                            // While listening a tap stops at once; otherwise wait
                            // briefly to tell a single tap from a double tap.
                            if (look == Look.Listening) listener.onTap() else postDelayed(singleTap, 260)
                        }
                    }
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPress)
                if (dragging) listener.onDragEnd()
            }
        }
        return true
    }
}
