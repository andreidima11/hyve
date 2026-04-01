package com.example.meminibridge

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Standalone settings screen for configuring server URLs and home WiFi.
 *
 * Launched from:
 * - MainActivity when no server URL is configured yet
 * - The `meminibridge://settings` deep link on the login page
 */
class SettingsActivity : AppCompatActivity() {

    private lateinit var prefs: AppPreferences
    private lateinit var wifiHelper: WifiHelper

    private lateinit var inputExternal: EditText
    private lateinit var inputLocal: EditText
    private lateinit var inputWifi: EditText
    private lateinit var ssidLabel: TextView

    private val locationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) detectWifi()
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> refreshPermissionStatus() }

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> refreshPermissionStatus() }

    private val locationPermissionForSettings = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> refreshPermissionStatus() }

    private val storagePermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> refreshPermissionStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        prefs = AppPreferences(this)
        wifiHelper = WifiHelper(this)

        // Style the logo: "Mĕ" white, "mini" accent blue
        val logoText = findViewById<TextView>(R.id.settings_logo_text)
        val fullText = "Mĕmini"
        val spannable = SpannableString(fullText)
        spannable.setSpan(ForegroundColorSpan(Color.parseColor("#f8fafc")), 0, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        spannable.setSpan(ForegroundColorSpan(Color.parseColor("#38bdf8")), 2, 6, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        logoText.text = spannable

        inputExternal = findViewById(R.id.settings_url_external)
        inputLocal = findViewById(R.id.settings_url_local)
        inputWifi = findViewById(R.id.settings_wifi_ssid)
        ssidLabel = findViewById(R.id.settings_current_ssid)

        // Populate current values
        inputExternal.setText(prefs.externalUrl)
        inputLocal.setText(prefs.localUrl)
        inputWifi.setText(prefs.homeWifi)

        // Show current SSID
        val ssid = wifiHelper.getCurrentSsid()
        if (ssid != null) {
            ssidLabel.text = "Current WiFi: $ssid"
        }

        // Detect WiFi button
        findViewById<Button>(R.id.settings_detect_wifi).setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED
            ) {
                locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            } else {
                detectWifi()
            }
        }

        // Save button
        findViewById<Button>(R.id.settings_save).setOnClickListener {
            saveAndFinish()
        }

        // ── Permissions section ──────────────────────────────────
        findViewById<Button>(R.id.perm_mic_btn).setOnClickListener {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
        findViewById<Button>(R.id.perm_camera_btn).setOnClickListener {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
        findViewById<Button>(R.id.perm_location_btn).setOnClickListener {
            locationPermissionForSettings.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        findViewById<Button>(R.id.perm_storage_btn).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                storagePermission.launch(Manifest.permission.READ_MEDIA_IMAGES)
            } else {
                storagePermission.launch(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
        refreshPermissionStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshPermissionStatus()
    }

    private fun refreshPermissionStatus() {
        // Microphone
        val micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val micStatus = findViewById<TextView>(R.id.perm_mic_status)
        val micBtn = findViewById<Button>(R.id.perm_mic_btn)
        if (micGranted) {
            micStatus.text = "✓ Allowed"
            micStatus.setTextColor(Color.parseColor("#22c55e"))
            micBtn.text = "✓ Allow"
            micBtn.setTextColor(Color.parseColor("#22c55e"))
            micBtn.isEnabled = false
        } else {
            micStatus.text = "Not set"
            micStatus.setTextColor(Color.parseColor("#94a3b8"))
            micBtn.text = "Allow"
            micBtn.setTextColor(Color.parseColor("#38bdf8"))
            micBtn.isEnabled = true
        }
        // Camera
        val camGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        val camStatus = findViewById<TextView>(R.id.perm_camera_status)
        val camBtn = findViewById<Button>(R.id.perm_camera_btn)
        if (camGranted) {
            camStatus.text = "✓ Allowed"
            camStatus.setTextColor(Color.parseColor("#22c55e"))
            camBtn.text = "✓ Allow"
            camBtn.setTextColor(Color.parseColor("#22c55e"))
            camBtn.isEnabled = false
        } else {
            camStatus.text = "Not set"
            camStatus.setTextColor(Color.parseColor("#94a3b8"))
            camBtn.text = "Allow"
            camBtn.setTextColor(Color.parseColor("#38bdf8"))
            camBtn.isEnabled = true
        }
        // Location
        val locGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val locStatus = findViewById<TextView>(R.id.perm_location_status)
        val locBtn = findViewById<Button>(R.id.perm_location_btn)
        if (locGranted) {
            locStatus.text = "✓ Allowed"
            locStatus.setTextColor(Color.parseColor("#22c55e"))
            locBtn.text = "✓ Allow"
            locBtn.setTextColor(Color.parseColor("#22c55e"))
            locBtn.isEnabled = false
        } else {
            locStatus.text = "Not set"
            locStatus.setTextColor(Color.parseColor("#94a3b8"))
            locBtn.text = "Allow"
            locBtn.setTextColor(Color.parseColor("#38bdf8"))
            locBtn.isEnabled = true
        }
        // Storage
        val storageGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }
        val storageStatus = findViewById<TextView>(R.id.perm_storage_status)
        val storageBtn = findViewById<Button>(R.id.perm_storage_btn)
        if (storageGranted) {
            storageStatus.text = "✓ Allowed"
            storageStatus.setTextColor(Color.parseColor("#22c55e"))
            storageBtn.text = "✓ Allow"
            storageBtn.setTextColor(Color.parseColor("#22c55e"))
            storageBtn.isEnabled = false
        } else {
            storageStatus.text = "Not set"
            storageStatus.setTextColor(Color.parseColor("#94a3b8"))
            storageBtn.text = "Allow"
            storageBtn.setTextColor(Color.parseColor("#38bdf8"))
            storageBtn.isEnabled = true
        }
    }

    private fun detectWifi() {
        val ssid = wifiHelper.getCurrentSsid()
        if (ssid != null) {
            inputWifi.setText(ssid)
            ssidLabel.text = "Current WiFi: $ssid"
            Toast.makeText(this, "WiFi detected: $ssid", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "Could not detect WiFi network.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun saveAndFinish() {
        val ext = inputExternal.text.toString().trim()
        val local = inputLocal.text.toString().trim()

        if (ext.isBlank() && local.isBlank()) {
            Toast.makeText(this, "Please enter at least one URL.", Toast.LENGTH_SHORT).show()
            return
        }

        prefs.externalUrl = ext
        prefs.localUrl = local
        prefs.homeWifi = inputWifi.text.toString().trim()

        setResult(RESULT_OK)
        finish()
    }
}
