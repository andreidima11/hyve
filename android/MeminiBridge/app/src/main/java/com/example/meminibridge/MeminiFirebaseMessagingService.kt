package com.example.meminibridge

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class MeminiFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "New FCM token received")
        PushRegistrationHelper.registerCurrentToken(this)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        val title = data["title"] ?: message.notification?.title ?: "Memini"
        val body = data["message"] ?: message.notification?.body ?: ""
        val sessionId = data["session_id"]?.takeIf { it.isNotBlank() }
        if (body.isBlank()) return
        NotificationHelper.createNotificationChannel(this)
        NotificationHelper.showNotification(this, title, body, sessionId)
    }

    companion object {
        private const val TAG = "MeminiFCM"
    }
}