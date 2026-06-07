package com.example.hyve

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Restarts the foreground notification service after reboot/update,
 * so background WebSocket notifications continue without opening the app.
 */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (
            action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != Intent.ACTION_USER_UNLOCKED
        ) {
            return
        }

        try {
            val prefs = AppPreferences(context)
            val hasToken = prefs.authToken.isNotBlank()
            val hasServerUrl = prefs.localUrl.isNotBlank() || prefs.externalUrl.isNotBlank()
            if (hasToken && hasServerUrl && prefs.websocketServiceEnabled) {
                NotificationService.start(context)
                Log.d("HyveBoot", "Started NotificationService on action=$action")
            } else {
                Log.d("HyveBoot", "Skip service start on action=$action (token/url missing or ws disabled)")
            }
        } catch (e: Exception) {
            Log.e("HyveBoot", "Receiver error: ${e.message}")
        }
    }
}
