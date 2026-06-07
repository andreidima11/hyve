package com.example.hyve

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import android.util.Log

/**
 * Helper for displaying native Android notifications.
 * Used for both WebSocket real-time notifications and background AlarmManager reminders.
 */
object NotificationHelper {

    private const val TAG = "NotificationHelper"
    private const val CHANNEL_ID = "hyve_reminders"
    private const val CHANNEL_NAME = "Hyve Reminders"
    private var notificationId = 1000

    // Dedup: prevent showing the same notification multiple times within a time window
    private const val DEDUP_WINDOW_MS = 30_000L
    private val recentNotifications = LinkedHashMap<String, Long>()

    fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notifications for Hyve reminders"
                enableVibration(true)
                enableLights(true)
                setShowBadge(true)
            }

            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
            Log.d(TAG, "Notification channel created")
        }
    }

    fun showNotification(context: Context, title: String, message: String, sessionId: String? = null) {
        try {
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                Log.w(TAG, "Notifications disabled at OS/app level; skipping native notification")
                return
            }
            // --- Dedup check: skip if same title+message shown within 30s ---
            val dedupKey = "$title|$message".hashCode().toString()
            val now = System.currentTimeMillis()
            synchronized(recentNotifications) {
                val lastShown = recentNotifications[dedupKey]
                if (lastShown != null && (now - lastShown) < DEDUP_WINDOW_MS) {
                    Log.d(TAG, "Dedup: skipping duplicate notification ($title)")
                    return
                }
                recentNotifications[dedupKey] = now
                // Cleanup old entries
                if (recentNotifications.size > 50) {
                    val cutoff = now - DEDUP_WINDOW_MS * 2
                    recentNotifications.entries.removeAll { it.value < cutoff }
                }
            }

            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val currentId = notificationId++

            // Intent to open app when notification tapped — includes the message
            // so MainActivity can display it in a chat window
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("from_notification", true)
                putExtra("notification_message", message)
                putExtra("notification_title", title)
                if (sessionId != null) putExtra("notification_session_id", sessionId)
            }

            // Unique request code per notification so each notification has its own PendingIntent
            val pendingIntent = PendingIntent.getActivity(
                context,
                currentId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(NotificationCompat.BigTextStyle().bigText(message))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVibrate(longArrayOf(0, 250, 250, 250))
                .setLights(0xFF38BDF8.toInt(), 500, 2000)
                .build()

            manager.notify(currentId, notification)
            Log.d(TAG, "Notification shown (#$currentId): $title - ${message.take(80)}")
        } catch (e: Exception) {
            Log.e(TAG, "Error showing notification: ${e.message}")
        }
    }
}
