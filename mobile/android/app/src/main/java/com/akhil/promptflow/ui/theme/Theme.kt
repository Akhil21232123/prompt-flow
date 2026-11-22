package com.akhil.promptflow.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

object Brand {
    val Violet = Color(0xFF8B7CFF)
    val Pink = Color(0xFFFF6FB5)
    val Blue = Color(0xFF4F8BFF)
    val Amber = Color(0xFFFFB547)
    val Ink = Color(0xFF0B0B12)
    val Surface = Color(0xFF15151F)
    val SurfaceHigh = Color(0xFF1E1E2B)
    val Muted = Color(0xFF9A9AB0)

    val flow = Brush.linearGradient(listOf(Violet, Pink))
    val prompt = Brush.linearGradient(listOf(Violet, Blue))
    val edit = Brush.linearGradient(listOf(Amber, Pink))
}

private val Dark = darkColorScheme(
    primary = Brand.Violet,
    secondary = Brand.Pink,
    tertiary = Brand.Blue,
    background = Brand.Ink,
    surface = Brand.Surface,
    surfaceVariant = Brand.SurfaceHigh,
    surfaceContainer = Brand.Surface,
    surfaceContainerHigh = Brand.SurfaceHigh,
    onBackground = Color(0xFFF2F2F7),
    onSurface = Color(0xFFF2F2F7),
    onSurfaceVariant = Brand.Muted,
    outline = Color(0xFF2E2E40),
)

private val Light = lightColorScheme(
    primary = Color(0xFF6A5AF9),
    secondary = Brand.Pink,
    tertiary = Brand.Blue,
)

private val Type = Typography(
    displaySmall = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.5).sp),
    headlineSmall = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun PromptFlowTheme(dark: Boolean = isSystemInDarkTheme() || true, content: @Composable () -> Unit) {
    // Dark-first: the brand gradient reads best on ink.
    MaterialTheme(colorScheme = if (dark) Dark else Light, typography = Type, content = content)
}
