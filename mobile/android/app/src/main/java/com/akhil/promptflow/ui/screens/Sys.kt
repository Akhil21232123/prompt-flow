package com.akhil.promptflow.ui.screens

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import com.akhil.promptflow.service.FlowAccessibilityService

/** Checks and shortcuts for the permissions PromptFlow needs. */
object Sys {
    fun hasMic(context: Context) =
        context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun bubbleEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            ?: return false
        val me = ComponentName(context, FlowAccessibilityService::class.java).flattenToString()
        return enabled.split(':').any { it.equals(me, ignoreCase = true) }
    }

    fun openAccessibilitySettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Is the PromptFlow keyboard enabled in system settings? */
    fun keyboardEnabled(context: Context): Boolean =
        com.akhil.promptflow.service.PromptFlowKeyboard.isEnabled(context)

    /** Settings → Keyboards, where the PromptFlow keyboard is switched on. */
    fun openKeyboardSettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** The system keyboard picker, to switch to PromptFlow. */
    fun showKeyboardPicker(context: Context) {
        context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showInputMethodPicker()
    }
}
