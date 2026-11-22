package com.akhil.promptflow.service

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo

/** Puts text into another app's text field at the cursor, replacing any selection. */
object TextInserter {

    /** Text currently in the field (not its placeholder hint). */
    fun currentText(node: AccessibilityNodeInfo): String =
        if (node.isShowingHintText) "" else node.text?.toString().orEmpty()

    fun selection(node: AccessibilityNodeInfo): String? {
        val text = currentText(node)
        val (s, e) = range(node, text)
        return if (e > s) text.substring(s, e) else null
    }

    /** The text before the cursor, used only to spell names already spoken. */
    fun before(node: AccessibilityNodeInfo, max: Int = 600): String {
        val text = currentText(node)
        val (s, _) = range(node, text)
        return text.substring(0, s).takeLast(max)
    }

    private fun range(node: AccessibilityNodeInfo, text: String): Pair<Int, Int> {
        var s = node.textSelectionStart
        var e = node.textSelectionEnd
        if (s < 0 || e < 0 || s > text.length || e > text.length) {
            s = text.length
            e = text.length
        }
        return if (s <= e) s to e else e to s
    }

    /** Spacing so dictated text doesn't glue onto the word before it. */
    fun joinable(before: String, insert: String): String {
        if (insert.isEmpty() || before.isEmpty()) return insert
        val last = before.last()
        val first = insert.first()
        val needsSpace = !last.isWhitespace() && !first.isWhitespace() && first !in ".,!?;:)]}" && last !in "([{"
        return if (needsSpace) " $insert" else insert
    }

    fun insert(context: Context, node: AccessibilityNodeInfo, text: String): Boolean {
        node.refresh()
        val current = currentText(node)
        val (s, e) = range(node, current)
        val piece = joinable(current.substring(0, s), text)
        val updated = current.substring(0, s) + piece + current.substring(e)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated)
        }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            val cursor = s + piece.length
            node.performAction(
                AccessibilityNodeInfo.ACTION_SET_SELECTION,
                Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor)
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor)
                },
            )
            return true
        }
        return paste(context, node, piece)
    }

    /** For fields that refuse SET_TEXT: paste via the clipboard, then restore it. */
    private fun paste(context: Context, node: AccessibilityNodeInfo, text: String): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        val previous = clipboard.primaryClip
        clipboard.setPrimaryClip(ClipData.newPlainText("PromptFlow", text))
        val ok = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        Handler(Looper.getMainLooper()).postDelayed({
            if (previous != null) clipboard.setPrimaryClip(previous) else clipboard.clearPrimaryClip()
        }, 600)
        return ok
    }
}
