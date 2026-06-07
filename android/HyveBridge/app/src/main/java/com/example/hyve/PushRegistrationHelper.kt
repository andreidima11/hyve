package com.example.hyve

import android.os.Build
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object PushRegistrationHelper {
    private const val TAG = "HyvePushReg"

    private fun ensureFirebaseReady(context: android.content.Context): Boolean {
        return try {
            if (FirebaseApp.getApps(context).isNotEmpty()) return true
            val options = FirebaseOptions.fromResource(context)
            if (options != null) {
                FirebaseApp.initializeApp(context, options)
                true
            } else {
                false
            }
        } catch (e: Exception) {
            Log.d(TAG, "Firebase not configured: ${e.message}")
            false
        }
    }

    private fun resolveServerUrl(context: android.content.Context): String {
        val prefs = AppPreferences(context)
        val wifiHelper = WifiHelper(context)
        val onHome = wifiHelper.isOnHomeWifi(prefs.homeWifi)
        val preferred = if (onHome) prefs.localUrl else prefs.externalUrl
        val fallback = if (onHome) prefs.externalUrl else prefs.localUrl
        return if (preferred.isNotBlank()) preferred else fallback
    }

    fun registerCurrentToken(context: android.content.Context, authToken: String? = null) {
        val token = (authToken ?: AppPreferences(context).authToken).trim()
        if (token.isBlank()) return
        if (!ensureFirebaseReady(context)) return

        FirebaseMessaging.getInstance().token.addOnSuccessListener { fcmToken ->
            if (fcmToken.isNullOrBlank()) return@addOnSuccessListener
            Thread {
                try {
                    val prefs = AppPreferences(context)
                    val serverUrl = resolveServerUrl(context)
                    if (serverUrl.isBlank()) return@Thread
                    val body = JSONObject().apply {
                        put("token", fcmToken)
                        put("installation_id", prefs.installationId)
                        put("platform", "android")
                        put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                        put("app_version", context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "")
                    }
                    val req = Request.Builder()
                        .url(serverUrl.trimEnd('/') + "/api/notifications/push/register")
                        .addHeader("Authorization", "Bearer $token")
                        .addHeader("Content-Type", "application/json")
                        .post(body.toString().toRequestBody("application/json".toMediaType()))
                        .build()
                    OkHttpClient().newCall(req).execute().use { resp ->
                        Log.d(TAG, "Push register status=${resp.code}")
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Push register failed: ${e.message}")
                }
            }.start()
        }.addOnFailureListener {
            Log.e(TAG, "FCM token fetch failed: ${it.message}")
        }
    }

    fun unregisterInstallation(context: android.content.Context, authToken: String?) {
        val token = (authToken ?: "").trim()
        if (token.isBlank()) return
        val prefs = AppPreferences(context)
        val serverUrl = resolveServerUrl(context)
        if (serverUrl.isBlank()) return
        Thread {
            try {
                val body = JSONObject().apply {
                    put("installation_id", prefs.installationId)
                }
                val req = Request.Builder()
                    .url(serverUrl.trimEnd('/') + "/api/notifications/push/unregister")
                    .addHeader("Authorization", "Bearer $token")
                    .addHeader("Content-Type", "application/json")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                OkHttpClient().newCall(req).execute().use { resp ->
                    Log.d(TAG, "Push unregister status=${resp.code}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Push unregister failed: ${e.message}")
            }
        }.start()
    }
}