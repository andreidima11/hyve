package com.example.hyve

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * Wrapper around SharedPreferences for storing server configuration,
 * WiFi settings, and biometric preference.
 */
class AppPreferences(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("hyve_prefs", Context.MODE_PRIVATE)

    // ── Critical fields use commit() (synchronous disk write) ────────
    // apply() is async — if the process is killed before the write completes,
    // settings are silently lost. URLs and auth token are critical, so we use
    // commit() to guarantee they survive process death.

    var externalUrl: String
        get() = prefs.getString(KEY_EXTERNAL_URL, "") ?: ""
        set(value) { prefs.edit().putString(KEY_EXTERNAL_URL, value).commit() }

    var localUrl: String
        get() = prefs.getString(KEY_LOCAL_URL, "") ?: ""
        set(value) { prefs.edit().putString(KEY_LOCAL_URL, value).commit() }

    var homeWifi: String
        get() = prefs.getString(KEY_HOME_WIFI, "") ?: ""
        set(value) { prefs.edit().putString(KEY_HOME_WIFI, value).commit() }

    var biometricEnabled: Boolean
        get() = prefs.getBoolean(KEY_BIOMETRIC_ENABLED, false)
        set(value) { prefs.edit().putBoolean(KEY_BIOMETRIC_ENABLED, value).commit() }

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) { prefs.edit().putString(KEY_AUTH_TOKEN, value).commit() }

    var websocketServiceEnabled: Boolean
        get() = prefs.getBoolean(KEY_WS_SERVICE_ENABLED, true)
        set(value) { prefs.edit().putBoolean(KEY_WS_SERVICE_ENABLED, value).commit() }

    var installationId: String
        get() {
            val existing = prefs.getString(KEY_INSTALLATION_ID, "") ?: ""
            if (existing.isNotBlank()) return existing
            val generated = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_INSTALLATION_ID, generated).commit()
            return generated
        }
        set(value) { prefs.edit().putString(KEY_INSTALLATION_ID, value).commit() }

    /** Last system bar color set by the web UI theme (hex, e.g. "#030712"). */
    var themeColor: String
        get() = prefs.getString(KEY_THEME_COLOR, "#030712") ?: "#030712"
        set(value) { prefs.edit().putString(KEY_THEME_COLOR, value).apply() }

    /** True when at least one server URL has been configured. */
    val hasServerUrl: Boolean
        get() = externalUrl.isNotBlank() || localUrl.isNotBlank()

    /**
     * Atomic batch save: writes all config fields in a single editor + commit().
     * Prevents partial writes (e.g. URL saved but WiFi lost) if process is killed.
     * Only overwrites a field if the new value is non-blank (protects against
     * accidental wipes from JS bridge calls with missing fields).
     */
    fun saveConfigAtomic(
        externalUrl: String?,
        localUrl: String?,
        homeWifi: String?,
        biometricEnabled: Boolean?
    ) {
        val editor = prefs.edit()
        if (!externalUrl.isNullOrBlank()) {
            editor.putString(KEY_EXTERNAL_URL, externalUrl)
        }
        if (!localUrl.isNullOrBlank()) {
            editor.putString(KEY_LOCAL_URL, localUrl)
        }
        // homeWifi can legitimately be empty (user clears it)
        if (homeWifi != null) {
            editor.putString(KEY_HOME_WIFI, homeWifi)
        }
        if (biometricEnabled != null) {
            editor.putBoolean(KEY_BIOMETRIC_ENABLED, biometricEnabled)
        }
        editor.commit()
    }

    companion object {
        private const val KEY_EXTERNAL_URL = "external_url"
        private const val KEY_LOCAL_URL = "local_url"
        private const val KEY_HOME_WIFI = "home_wifi"
        private const val KEY_BIOMETRIC_ENABLED = "biometric_enabled"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_WS_SERVICE_ENABLED = "ws_service_enabled"
        private const val KEY_INSTALLATION_ID = "installation_id"
        private const val KEY_THEME_COLOR = "theme_color"
    }
}
