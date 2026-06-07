package com.example.hyve

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket client for real-time notifications.
 * Connects to /ws/notifications endpoint on app start.
 * Receives reminder notifications instantly when reminders trigger.
 * 
 * Uses Handler instead of coroutines for reliability (OkHttp callbacks 
 * come from background threads — we post to main thread for UI work).
 */
class WebSocketClient(private val wsUrl: String) : WebSocketListener() {

    private var webSocket: WebSocket? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var reconnectAttempts = 0
    private val maxReconnectAttempts = 10
    private val reconnectDelayMs = 5000L
    private var isConnecting = false

    private var onReminderReceived: ((title: String, message: String, sessionId: String?) -> Unit)? = null

    fun setOnReminderReceived(callback: (title: String, message: String, sessionId: String?) -> Unit) {
        onReminderReceived = callback
    }

    fun connect() {
        if (webSocket != null || isConnecting) {
            Log.d(TAG, "WebSocket already connected or connecting")
            return
        }

        isConnecting = true
        try {
            Log.d(TAG, "Connecting to WebSocket: $wsUrl")

            val client = OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .connectTimeout(30, TimeUnit.SECONDS)
                .pingInterval(30, TimeUnit.SECONDS)  // OkHttp handles ping/pong automatically
                .build()

            val request = Request.Builder()
                .url(wsUrl)
                .build()

            webSocket = client.newWebSocket(request, this)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to connect: ${e.message}")
            isConnecting = false
            scheduleReconnect()
        }
    }

    fun disconnect() {
        mainHandler.removeCallbacksAndMessages(null)
        try {
            webSocket?.close(1000, "User disconnected")
        } catch (e: Exception) {
            Log.e(TAG, "Error disconnecting: ${e.message}")
        }
        webSocket = null
        isConnecting = false
    }

    private fun scheduleReconnect() {
        if (reconnectAttempts >= maxReconnectAttempts) {
            Log.e(TAG, "Max reconnect attempts reached ($maxReconnectAttempts)")
            return
        }

        reconnectAttempts++
        val delayMs = reconnectDelayMs * reconnectAttempts
        Log.d(TAG, "Scheduling reconnect attempt $reconnectAttempts in ${delayMs}ms")

        mainHandler.postDelayed({
            webSocket = null
            isConnecting = false
            connect()
        }, delayMs)
    }

    // --- OkHttp WebSocketListener callbacks (called on background thread) ---

    override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
        Log.d(TAG, "✅ WebSocket CONNECTED to server")
        isConnecting = false
        reconnectAttempts = 0
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        Log.d(TAG, "📩 WebSocket message received: $text")
        try {
            val json = JSONObject(text)
            val type = json.optString("type")

            when (type) {
                "reminder", "automation" -> {
                    val title = json.optString("title", "Hyve")
                    val message = json.optString("message", "")
                    val sessionId = if (json.has("session_id")) json.optString("session_id", null) else null
                    Log.d(TAG, "🔔 $type notification: $title - $message (session=$sessionId)")
                    
                    // Invoke callback on main thread
                    mainHandler.post {
                        try {
                            onReminderReceived?.invoke(title, message, sessionId)
                        } catch (e: Exception) {
                            Log.e(TAG, "Callback error: ${e.message}")
                        }
                    }
                }
                "pong" -> {
                    Log.d(TAG, "Pong received")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing message: ${e.message}")
        }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
        Log.e(TAG, "❌ WebSocket FAILURE: ${t.message}")
        this.webSocket = null
        isConnecting = false
        scheduleReconnect()
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WebSocket closing: $code $reason")
        webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WebSocket closed: $code $reason")
        this.webSocket = null
        isConnecting = false
        if (code != 1000) {
            scheduleReconnect()
        }
    }

    companion object {
        private const val TAG = "HyveWS"
    }
}
