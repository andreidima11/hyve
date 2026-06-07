package com.example.hyve

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver for handling reminder alarms triggered by AlarmManager.
 * Runs when app is backgrounded or phone screen is off.
 * Shows native notification to alert user of reminder.
 */
class ReminderBroadcastReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        Log.d(TAG, "ReminderBroadcastReceiver triggered")

        val message = intent.getStringExtra("message") ?: "Reminder"
        val title = intent.getStringExtra("title") ?: "Hyve"

        // Ensure notification channel exists
        NotificationHelper.createNotificationChannel(context)
        
        // Show notification immediately
        NotificationHelper.showNotification(context, title, message)

        // Background sync via simple thread (no coroutines needed)
        Thread {
            syncReminders(context)
        }.start()

        Log.d(TAG, "Reminder notification shown: $title - $message")
    }

    private fun syncReminders(context: Context) {
        try {
            val prefs = AppPreferences(context)
            val token = prefs.authToken
            if (token.isEmpty()) return

            val serverUrl = if (prefs.localUrl.isNotBlank()) prefs.localUrl else prefs.externalUrl
            if (serverUrl.isBlank()) return

            val client = okhttp3.OkHttpClient()
            val request = okhttp3.Request.Builder()
                .url("${serverUrl.trimEnd('/')}/api/notifications/check")
                .addHeader("Authorization", "Bearer $token")
                .build()

            val response = client.newCall(request).execute()
            if (response.isSuccessful) {
                Log.d(TAG, "Notifications synced in background")
            }
            response.close()
        } catch (e: Exception) {
            Log.d(TAG, "Background sync error (non-critical): ${e.message}")
        }
    }

    companion object {
        private const val TAG = "ReminderReceiver"
        const val ACTION_REMINDER = "com.example.hyve.ACTION_REMINDER_ALARM"
    }
}
