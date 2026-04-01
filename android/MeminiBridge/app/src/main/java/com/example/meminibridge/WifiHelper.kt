package com.example.meminibridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import androidx.core.content.ContextCompat

/**
 * Detects the current WiFi SSID and determines whether the device
 * is on the configured home network.
 */
class WifiHelper(private val context: Context) {

    /**
     * Returns the current WiFi SSID (without quotes), or null if unavailable.
     * Requires ACCESS_FINE_LOCATION permission on Android 8.1+.
     */
    @Suppress("deprecation")
    fun getCurrentSsid(): String? {
        // Location permission is required since Android 8.1 to read SSID
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return null
        }

        val wifiManager = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val info = wifiManager.connectionInfo
        val ssid = info?.ssid?.removeSurrounding("\"")
        return if (ssid.isNullOrBlank() || ssid == "<unknown ssid>") null else ssid
    }

    /**
     * Returns true when the device is currently connected to the home WiFi.
     */
    fun isOnHomeWifi(homeWifi: String): Boolean {
        if (homeWifi.isBlank()) return false
        return getCurrentSsid()?.equals(homeWifi, ignoreCase = true) == true
    }
}
