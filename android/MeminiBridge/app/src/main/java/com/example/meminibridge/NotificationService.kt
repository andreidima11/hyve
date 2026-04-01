package com.example.meminibridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * Foreground Service that keeps a WebSocket connection alive to the Memini server.
 * 
 * This ensures real-time notifications are received even when the app is in the
 * background or the screen is off — just like WhatsApp, Telegram, etc.
 *
 * The service shows a minimal persistent notification ("Connected to Memini")
 * and automatically reconnects the WebSocket on network changes.
 */
class NotificationService : Service() {

    companion object {
        private const val TAG = "MeminiService"
        private const val SERVICE_CHANNEL_ID = "memini_service"
        private const val SERVICE_CHANNEL_NAME = "Memini Connection"
        private const val SERVICE_NOTIFICATION_ID = 1
        @Volatile private var active = false

        /** Start (or restart) the foreground notification service. */
        fun start(context: Context) {
            val intent = Intent(context, NotificationService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** Stop the foreground notification service. */
        fun stop(context: Context) {
            context.stopService(Intent(context, NotificationService::class.java))
        }

        fun isActive(): Boolean = active
    }

    private var webSocketClient: WebSocketClient? = null
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        active = true
        Log.d(TAG, "Service created")
        createServiceChannel()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Service onStartCommand")

        val prefs = AppPreferences(this)
        if (!prefs.websocketServiceEnabled) {
            Log.d(TAG, "Service start ignored: native WS preference disabled")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // Show the persistent "connected" notification (required for foreground service)
        startForeground(SERVICE_NOTIFICATION_ID, buildServiceNotification())

        // Only connect WebSocket if not already connected (prevent duplicate connections)
        if (webSocketClient == null) {
            connectWebSocket()
        } else {
            Log.d(TAG, "WebSocket already active — skipping reconnect")
        }

        // If system kills us, restart automatically
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed, disconnecting WebSocket")
        active = false
        unregisterNetworkCallback()
        webSocketClient?.disconnect()
        webSocketClient = null
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        // Some OEMs kill foreground services when the app is swiped away.
        // Schedule a quick restart if we still have a valid login token.
        try {
            val prefs = AppPreferences(this)
            if (prefs.authToken.isBlank()) return
            val restartIntent = Intent(applicationContext, NotificationService::class.java)
            val pending = PendingIntent.getService(
                applicationContext,
                42,
                restartIntent,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarm = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarm.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 5000L,
                pending
            )
            Log.d(TAG, "Task removed: scheduled service restart in 5s")
        } catch (e: Exception) {
            Log.e(TAG, "onTaskRemoved restart scheduling failed: ${e.message}")
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  WebSocket connection
    // ──────────────────────────────────────────────────────────────

    private fun connectWebSocket() {
        val prefs = AppPreferences(this)
        val token = prefs.authToken

        if (token.isBlank()) {
            Log.w(TAG, "No auth token — cannot connect WebSocket. Waiting for login.")
            return
        }

        // Disconnect old client if present
        webSocketClient?.disconnect()
        webSocketClient = null

        // Resolve server URL (local or external based on WiFi)
        val wifiHelper = WifiHelper(this)
        val onHome = wifiHelper.isOnHomeWifi(prefs.homeWifi)
        val preferred = if (onHome) prefs.localUrl else prefs.externalUrl
        val fallback = if (onHome) prefs.externalUrl else prefs.localUrl
        val baseUrl = if (preferred.isNotBlank()) preferred else fallback

        if (baseUrl.isBlank()) {
            Log.w(TAG, "No server URL configured")
            return
        }

        if (!isWebSocketEnabledByServer(baseUrl, token)) {
            Log.d(TAG, "WebSocket delivery disabled by server config — stopping NotificationService")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }

        val wsUrl = baseUrl
            .replace("http://", "ws://")
            .replace("https://", "wss://")
            .trimEnd('/') + "/ws/notifications?token=$token"

        Log.d(TAG, "Connecting WebSocket to: ${wsUrl.take(60)}...")

        webSocketClient = WebSocketClient(wsUrl).apply {
            setOnReminderReceived { title, message, sessionId ->
                Log.d(TAG, "🔔 Received reminder: $title - $message (session=$sessionId)")
                NotificationHelper.showNotification(
                    this@NotificationService,
                    title,
                    message,
                    sessionId
                )
            }
            connect()
        }
    }

    private fun isWebSocketEnabledByServer(baseUrl: String, token: String): Boolean {
        return try {
            val req = Request.Builder()
                .url(baseUrl.trimEnd('/') + "/api/config")
                .addHeader("Authorization", "Bearer $token")
                .get()
                .build()
            OkHttpClient().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) {
                    Log.w(TAG, "Config check failed status=${resp.code}; keeping WebSocket enabled")
                    return true
                }
                val body = resp.body?.string() ?: return true
                val root = JSONObject(body)
                val fcm = root.optJSONObject("fcm")
                if (fcm == null) return true
                val transportMode = fcm.optString("transport_mode", "hybrid").lowercase()
                val wsEnabled = fcm.optBoolean("websocket_enabled", true)
                wsEnabled && transportMode != "firebase"
            }
        } catch (e: Exception) {
            Log.w(TAG, "Config check exception: ${e.message}; keeping WebSocket enabled")
            true
        }
    }

    private fun registerNetworkCallback() {
        try {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            connectivityManager = manager
            if (networkCallback != null) return
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.d(TAG, "Network available — reconnecting WebSocket")
                    connectWebSocket()
                }

                override fun onLost(network: Network) {
                    Log.d(TAG, "Network lost")
                }
            }
            manager.registerDefaultNetworkCallback(networkCallback!!)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register network callback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            val manager = connectivityManager ?: return
            val callback = networkCallback ?: return
            manager.unregisterNetworkCallback(callback)
        } catch (_: Exception) {
        } finally {
            networkCallback = null
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  Service notification channel + builder
    // ──────────────────────────────────────────────────────────────

    private fun createServiceChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                SERVICE_CHANNEL_ID,
                SERVICE_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW   // silent, no sound/vibration
            ).apply {
                description = "Keeps Memini connected for instant notifications"
                setShowBadge(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildServiceNotification(): Notification {
        // Tap opens the app
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Memini")
            .setContentText("Connected — notifications active")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
