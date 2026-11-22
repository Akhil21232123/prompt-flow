package com.akhil.promptflow.ui.components

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.akhil.promptflow.core.DictationState
import com.akhil.promptflow.core.Mode
import com.akhil.promptflow.ui.theme.Brand
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

fun brushFor(mode: Mode): Brush = when (mode) {
    Mode.Dictate -> Brand.flow
    Mode.Engineer -> Brand.prompt
    Mode.Command -> Brand.edit
}

/** The big tappable orb on Home: breathes when idle, dances with your voice. */
@Composable
fun Orb(
    state: DictationState,
    mode: Mode,
    size: Dp = 168.dp,
    onHoldStart: () -> Unit = {},
    onHoldEnd: () -> Unit = {},
    onClick: () -> Unit,
) {
    // Latest callbacks, read inside the long-lived gesture handler.
    val onClickState = rememberUpdatedState(onClick)
    val onHoldStartState = rememberUpdatedState(onHoldStart)
    val onHoldEndState = rememberUpdatedState(onHoldEnd)
    val t = rememberInfiniteTransition(label = "orb")
    val breathe by t.animateFloat(
        0.96f, 1.04f,
        infiniteRepeatable(tween(2200, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breathe",
    )
    val phase by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "phase")
    val level = (state as? DictationState.Listening)?.level ?: 0f
    val lvl by animateFloatAsState(level, spring(stiffness = 400f), label = "level")
    val listening = state is DictationState.Listening
    val working = state is DictationState.Working
    val scale by animateFloatAsState(
        if (listening) 1f + lvl * 0.15f else breathe,
        spring(dampingRatio = 0.55f, stiffness = 300f), label = "scale",
    )
    val brush = brushFor((state as? DictationState.Listening)?.mode ?: mode)

    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(size + 40.dp)) {
        Canvas(Modifier.size(size + 40.dp)) {
            if (listening) {
                for (i in 0..2) {
                    val p = (phase + i / 3f) % 1f
                    drawCircle(Brand.Pink.copy(alpha = (1 - p) * 0.35f * (0.4f + lvl)), radius = this.size.minDimension / 2 * (0.7f + p * 0.3f))
                }
            }
        }
        Box(
            Modifier
                .size(size)
                .scale(scale)
                .clip(CircleShape)
                .background(brush)
                .pointerInput(Unit) {
                    // Tap, or hold past HOLD_MS (released = hold ended).
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        val up = withTimeoutOrNull(com.akhil.promptflow.core.Gestures.HOLD_MS) { waitForUpOrCancellation() }
                        if (up != null) {
                            onClickState.value()
                        } else {
                            onHoldStartState.value()
                            waitForUpOrCancellation()
                            onHoldEndState.value()
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(size * 0.5f)) {
                val w = this.size.width
                val h = this.size.height
                if (working) {
                    drawArc(Color.White, phase * 360f, 110f, false, style = Stroke(width = 6f), topLeft = Offset(w * 0.15f, h * 0.15f), size = Size(w * 0.7f, h * 0.7f))
                } else {
                    val bars = 5
                    val gap = w / (bars * 2 - 1)
                    for (i in 0 until bars) {
                        val wave = if (listening) 0.3f + 0.7f * abs(sin(phase * 2 * PI.toFloat() + i * 0.9f)) * (0.35f + lvl)
                        else 1f - 0.22f * abs(2 - i)
                        val bh = (h * 0.85f * wave.coerceIn(0.15f, 1f))
                        drawRoundRect(
                            Color.White,
                            topLeft = Offset(gap * i * 2, (h - bh) / 2),
                            size = Size(gap, bh),
                            cornerRadius = CornerRadius(gap / 2, gap / 2),
                        )
                    }
                }
            }
        }
    }
}

/** Three-way pill switch for Dictate / Prompt / Edit. */
@Composable
fun ModeSwitch(mode: Mode, onChange: (Mode) -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Mode.entries.forEach { m ->
            val selected = m == mode
            val alpha by animateFloatAsState(if (selected) 1f else 0f, tween(220), label = "pill")
            Box(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(brushFor(m), alpha = alpha)
                    .clickable { onChange(m) }
                    .padding(horizontal = 18.dp, vertical = 9.dp),
            ) {
                Text(
                    m.label,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (selected) Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(18.dp),
    ) { content() }
}

@Composable
fun Stat(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun GradientButton(text: String, modifier: Modifier = Modifier, brush: Brush = Brand.flow, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(brush, alpha = if (enabled) 1f else 0.4f)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = Color.White)
    }
}

/** Chips for the double-tap style. */
@Composable
fun StylePicker(selected: com.akhil.promptflow.core.StylePreset, onChange: (com.akhil.promptflow.core.StylePreset) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        com.akhil.promptflow.core.StylePreset.entries.forEach { p ->
            val on = p == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(if (on) brushFor(Mode.Dictate) else androidx.compose.ui.graphics.SolidColor(Brand.SurfaceHigh))
                    .clickable { onChange(p) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text(
                    p.label,
                    color = if (on) Color.White else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
