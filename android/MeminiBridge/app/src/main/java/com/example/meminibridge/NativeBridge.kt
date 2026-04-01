package com.example.meminibridge

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * JavaScript interface exposed to the WebView as `MeminiNative`.
 *
 * The injected bridge script (see [buildBridgeScript]) maps these methods
 * to the global `window.__*` functions that the web UI expects.
 */
class NativeBridge(
    private val prefs: AppPreferences,
    private val wifiHelper: WifiHelper,
    private val onClearCache: () -> Unit,
    private val onConfigSaved: () -> Unit,
    private val onSetSystemBarColor: (String) -> Unit,
    private val onAuthTokenReceived: ((String) -> Unit)? = null,
    private val onAuthTokenCleared: ((String) -> Unit)? = null,
    private val onSetWsServiceEnabled: ((Boolean) -> Unit)? = null,
    private val onCheckPermission: ((String) -> String)? = null,
    private val onRequestPermission: ((String) -> Unit)? = null,
    private val onGetWsServiceStatus: (() -> Boolean)? = null
) {

    /**
     * Called from JS: `window.__saveNativeServerConfig(config)`.
     * Receives a JSON string with externalUrl, localUrl, homeWifi, biometricEnabled.
     */
    @JavascriptInterface
    fun saveServerConfig(jsonStr: String) {
        try {
            val json = JSONObject(jsonStr)
            val ext = json.optString("externalUrl", "").trim()
            val local = json.optString("localUrl", "").trim()
            val wifi = json.optString("homeWifi", "").trim()
            val bio = if (json.has("biometricEnabled")) json.optBoolean("biometricEnabled", false) else null

            // Guard: don't wipe existing URLs if JS sends empty config
            // (e.g. page reload, bridge re-init, settings page opened without values)
            if (ext.isBlank() && local.isBlank() && prefs.hasServerUrl) {
                android.util.Log.w("Memini", "NativeBridge.saveServerConfig: ignoring empty URLs (existing config preserved)")
                return
            }

            // Atomic write: single editor + commit() — survives process death
            prefs.saveConfigAtomic(
                externalUrl = ext.ifBlank { null },
                localUrl = local.ifBlank { null },
                homeWifi = wifi,
                biometricEnabled = bio
            )
            android.util.Log.d("Memini", "NativeBridge.saveServerConfig: saved (ext=${ext.take(30)}, local=${local.take(30)})")
            Handler(Looper.getMainLooper()).post { onConfigSaved() }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Called from JS: `window.__getNativeWifiSsid()`.
     * Returns the current WiFi SSID or empty string.
     */
    @JavascriptInterface
    fun getWifiSsid(): String {
        return wifiHelper.getCurrentSsid() ?: ""
    }

    /**
     * Called from JS: `window.__clearNativeCache()`.
     */
    @JavascriptInterface
    fun clearCache() {
        Handler(Looper.getMainLooper()).post { onClearCache() }
    }

    /**
     * Called from JS: `window.__setNativeSystemBarColor(colorHex)`.
     * Updates the status/navigation bar colors to match the web UI.
     * Example: "#0d0d0d" or "#1a1a2e"
     */
    @JavascriptInterface
    fun setSystemBarColor(colorHex: String) {
        Handler(Looper.getMainLooper()).post { onSetSystemBarColor(colorHex) }
    }

    /**
     * Called from JS: `window.__saveNativeAuthToken(token)`.
     * Stores the JWT auth token from the web UI for use by the native WebSocket client.
     */
    @JavascriptInterface
    fun saveAuthToken(token: String) {
        try {
            android.util.Log.d("Memini", "NativeBridge.saveAuthToken called, token=${token.take(10)}...")
            prefs.authToken = token
            Handler(Looper.getMainLooper()).post {
                onAuthTokenReceived?.invoke(token)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Called from JS: `window.__clearNativeAuthToken()`.
     * Clears the stored JWT auth token and allows the app to stop background WS service.
     */
    @JavascriptInterface
    fun clearAuthToken() {
        try {
            android.util.Log.d("Memini", "NativeBridge.clearAuthToken called")
            val oldToken = prefs.authToken
            prefs.authToken = ""
            Handler(Looper.getMainLooper()).post {
                onAuthTokenCleared?.invoke(oldToken)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Called from JS: `window.__setNativeWsServiceEnabled(enabled)`.
     * Stores native preference and starts/stops Android foreground WS service.
     */
    @JavascriptInterface
    fun setWsServiceEnabled(enabled: Boolean) {
        Handler(Looper.getMainLooper()).post {
            onSetWsServiceEnabled?.invoke(enabled)
        }
    }

    /**
     * Called from JS: `window.__checkNativePermission(name)`.
     * Returns "granted", "denied", or "prompt".
     * Valid names: microphone, camera, location, storage
     */
    @JavascriptInterface
    fun checkPermission(name: String): String {
        return onCheckPermission?.invoke(name) ?: "prompt"
    }

    /**
     * Called from JS: `window.__requestNativePermission(name)`.
     * Triggers the native Android permission dialog.
     * The result is sent back via JS callback `window.__onNativePermissionResult(name, granted)`.
     */
    @JavascriptInterface
    fun requestPermission(name: String) {
        Handler(Looper.getMainLooper()).post {
            onRequestPermission?.invoke(name)
        }
    }

    /**
     * Called from JS: `window.__getNativeWsServiceStatus()`.
     * Returns true when NotificationService is active, false otherwise.
     */
    @JavascriptInterface
    fun getWsServiceStatus(): Boolean {
        return onGetWsServiceStatus?.invoke() ?: false
    }

    companion object {
        /**
         * Builds the JavaScript that creates the native bridge globals
         * (`window.__MEMINI_NATIVE_APP`, `window.__MEMINI_NATIVE_CONFIG`, etc.)
         * which the web UI's `initNativeAppBridge()` looks for.
         */
        fun buildBridgeScript(
            prefs: AppPreferences,
            wifiHelper: WifiHelper,
            biometricAvailable: Boolean
        ): String {
            val currentSsid = wifiHelper.getCurrentSsid() ?: ""
            val onHomeWifi = wifiHelper.isOnHomeWifi(prefs.homeWifi)
            val serverMode = if (onHomeWifi && prefs.localUrl.isNotBlank()) "local" else "external"

            // Escape values for JS string literals
            fun esc(s: String) = s
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")

            return """
                (function() {
                    window.__MEMINI_NATIVE_APP = true;

                    window.__MEMINI_NATIVE_CONFIG = {
                        externalUrl:        '${esc(prefs.externalUrl)}',
                        localUrl:           '${esc(prefs.localUrl)}',
                        homeWifi:           '${esc(prefs.homeWifi)}',
                        currentSsid:        '${esc(currentSsid)}',
                        biometricEnabled:   ${prefs.biometricEnabled},
                        biometricAvailable: $biometricAvailable,
                        serverMode:         '$serverMode'
                    };

                    window.__saveNativeServerConfig = function(config) {
                        MeminiNative.saveServerConfig(JSON.stringify(config));
                    };

                    window.__getNativeWifiSsid = function() {
                        return MeminiNative.getWifiSsid();
                    };

                    window.__clearNativeCache = function() {
                        MeminiNative.clearCache();
                    };

                    window.__setNativeSystemBarColor = function(colorHex) {
                        MeminiNative.setSystemBarColor(colorHex);
                    };

                    window.__saveNativeAuthToken = function(token) {
                        MeminiNative.saveAuthToken(token);
                    };

                    window.__clearNativeAuthToken = function() {
                        MeminiNative.clearAuthToken();
                    };

                    window.__setNativeWsServiceEnabled = function(enabled) {
                        MeminiNative.setWsServiceEnabled(!!enabled);
                    };

                    window.__checkNativePermission = function(name) {
                        return MeminiNative.checkPermission(name);
                    };

                    window.__requestNativePermission = function(name) {
                        MeminiNative.requestPermission(name);
                    };

                    window.__getNativeWsServiceStatus = function() {
                        return !!MeminiNative.getWsServiceStatus();
                    };

                    document.body.classList.add('memini-native-app');

                    // Apply saved theme color immediately to avoid flicker
                    try {
                        var savedColor = localStorage.getItem('memini_theme_color');
                        if (savedColor) window.__setNativeSystemBarColor(savedColor);
                    } catch(e) {}
                })();
            """.trimIndent()
        }
    }
}
