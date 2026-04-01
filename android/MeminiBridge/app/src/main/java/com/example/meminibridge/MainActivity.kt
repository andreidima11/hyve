package com.example.meminibridge

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale


/**
 * Main activity — hosts a full-screen WebView that loads the Memini Bridge UI.
 *
 * On every page load the native bridge JS is injected so the web UI can access
 * WiFi SSID detection, biometric toggle, dual-URL config and cache clearing
 * through `window.__MEMINI_*` globals.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var contentRoot: FrameLayout
    private lateinit var prefs: AppPreferences
    private lateinit var wifiHelper: WifiHelper
    private lateinit var biometricHelper: BiometricHelper

    private var pendingBiometric = false
    private var pendingWebPermission: PermissionRequest? = null

    // Pending notification message to show in chat after WebView loads
    private var pendingNotificationMessage: String? = null
    private var pendingNotificationTitle: String? = null
    private var pendingNotificationSessionId: String? = null
    private var pageLoaded = false

    // ── Activity result: settings screen ──────────────────────────────
    private val settingsLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            // Server config may have changed — reload
            loadServerUrl()
        }
    }

    // ── Permission request for location (WiFi SSID) ──────────────────
    private val locationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            // Re-inject bridge so the SSID is available
            injectBridge()
        }
        // Continue regardless
        proceedAfterBiometric()
    }

    // ── Permission request for microphone (voice input) ──────────────
    private val audioPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val pending = pendingWebPermission
        pendingWebPermission = null
        if (granted && pending != null) {
            pending.grant(pending.resources)
        } else {
            pending?.deny()
        }
    }

    // ── Permission for notifications (Android 13+) ───────────────────
    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            android.util.Log.d("Memini", "POST_NOTIFICATIONS permission granted")
        } else {
            android.util.Log.w("Memini", "POST_NOTIFICATIONS permission denied — notifications won't show")
        }
    }

    // ── Generic permission launcher (used by bridge checkPermission/requestPermission) ──
    private var pendingPermissionName: String? = null

    private val bridgePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val name = pendingPermissionName ?: return@registerForActivityResult
        pendingPermissionName = null
        android.util.Log.d("Memini", "Bridge permission result: $name = $granted")
        webView.post {
            webView.evaluateJavascript(
                "if(window.__onNativePermissionResult)window.__onNativePermissionResult('$name',$granted);",
                null
            )
        }
    }

    /** Check if a specific permission is currently granted */
    private fun checkAndroidPermission(name: String): String {
        val perm = permissionNameToManifest(name) ?: return "prompt"
        return if (ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED) {
            "granted"
        } else {
            "prompt"
        }
    }

    /** Request a specific Android permission by name */
    private fun requestAndroidPermission(name: String) {
        val perm = permissionNameToManifest(name)
        if (perm == null) {
            android.util.Log.w("Memini", "Unknown permission name: $name")
            return
        }
        if (ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED) {
            // Already granted — notify JS immediately
            webView.post {
                webView.evaluateJavascript(
                    "if(window.__onNativePermissionResult)window.__onNativePermissionResult('$name',true);",
                    null
                )
            }
            return
        }
        pendingPermissionName = name
        bridgePermissionLauncher.launch(perm)
    }

    /** Map JS permission name to Android Manifest constant */
    private fun permissionNameToManifest(name: String): String? {
        return when (name) {
            "microphone" -> Manifest.permission.RECORD_AUDIO
            "camera" -> Manifest.permission.CAMERA
            "location" -> Manifest.permission.ACCESS_FINE_LOCATION
            "storage" -> {
                if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES
                else Manifest.permission.READ_EXTERNAL_STORAGE
            }
            else -> null
        }
    }

    // ── File picker for attachments (images, documents) ──────────────
    private var fileChooserCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = fileChooserCallback
        fileChooserCallback = null
        if (result.resultCode == RESULT_OK) {
            // If we have a cameraPhotoUri, the photo was taken to that file
            val camUri = cameraPhotoUri
            cameraPhotoUri = null
            val dataUri = result.data?.data
            if (camUri != null) {
                cb?.onReceiveValue(arrayOf(camUri))
            } else if (dataUri != null) {
                cb?.onReceiveValue(arrayOf(dataUri))
            } else {
                cb?.onReceiveValue(arrayOf())
            }
        } else {
            cameraPhotoUri = null
            cb?.onReceiveValue(arrayOf())
        }
    }

    // ── Camera permission for capture ──────────────────────────────
    private var pendingCameraChooserParams: WebChromeClient.FileChooserParams? = null
    private var pendingCameraFilePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val params = pendingCameraChooserParams
        val cb = pendingCameraFilePathCallback
        pendingCameraChooserParams = null
        pendingCameraFilePathCallback = null
        if (granted && cb != null) {
            launchCameraCapture(cb)
        } else {
            cb?.onReceiveValue(arrayOf())
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Lifecycle
    // ══════════════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Read saved theme color BEFORE setContentView for zero-flicker launch
        val earlyPrefs = AppPreferences(this)
        val savedColor = try {
            android.graphics.Color.parseColor(earlyPrefs.themeColor)
        } catch (_: Exception) {
            android.graphics.Color.parseColor("#030712")
        }

        // Edge-to-edge: system bars match saved theme color
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.statusBarColor = savedColor
        @Suppress("DEPRECATION")
        window.navigationBarColor = savedColor

        // Switch icon color based on saved background luminance
        val luminance = androidx.core.graphics.ColorUtils.calculateLuminance(savedColor)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = luminance > 0.5
            isAppearanceLightNavigationBars = luminance > 0.5
        }

        setContentView(R.layout.activity_main)

        // Set Recents/Task Switcher icon to the app logo
        try {
            val icon = BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher)
            @Suppress("DEPRECATION")
            setTaskDescription(ActivityManager.TaskDescription(getString(R.string.app_name), icon, savedColor))
        } catch (_: Exception) {}

        contentRoot = findViewById(R.id.content_root)
        webView = findViewById(R.id.webview)

        // Apply saved theme color to contentRoot background
        contentRoot.setBackgroundColor(savedColor)

        // Apply system bar + IME (keyboard) insets so content is never hidden under the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime  = insets.getInsets(WindowInsetsCompat.Type.ime())
            // Bottom padding = whichever is taller: nav-bar or on-screen keyboard
            val bottomPad = maxOf(bars.bottom, ime.bottom)
            v.setPadding(bars.left, bars.top, bars.right, bottomPad)

            // Notify the web page so it can scroll the chat to the last message
            val kbHeight = ime.bottom
            webView.post {
                webView.evaluateJavascript(
                    "if(window.__onAndroidKeyboard)window.__onAndroidKeyboard($kbHeight);",
                    null
                )
            }
            insets
        }

        prefs = AppPreferences(this)
        wifiHelper = WifiHelper(this)
        biometricHelper = BiometricHelper(this)

        // Create notification channel for reminders (Android 8+)
        NotificationHelper.createNotificationChannel(this)

        // Request notification permission (Android 13+ / API 33+)
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        setupWebView()
        setupBackNavigation()

        // If no URL configured yet, open settings first
        if (!prefs.hasServerUrl) {
            openSettings()
            return
        }

        // Request location permission for WiFi SSID detection
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            return
        }

        // Biometric gate
        if (prefs.biometricEnabled && biometricHelper.isAvailable) {
            pendingBiometric = true
            webView.visibility = View.INVISIBLE
            // Save notification intent for after biometric + page load
            handleNotificationIntent(intent)
            biometricHelper.authenticate(
                onSuccess = { proceedAfterBiometric() },
                onFailure = { finishAffinity() }
            )
        } else {
            // Save notification intent before loading page (will inject after page loads)
            handleNotificationIntent(intent)
            loadServerUrl()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationIntent(intent)
        handleDeepLink(intent)
    }

    // ══════════════════════════════════════════════════════════════════
    //  WebView setup
    // ══════════════════════════════════════════════════════════════════

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val bridge = NativeBridge(
            prefs = prefs,
            wifiHelper = wifiHelper,
            onClearCache = { clearWebViewCache() },
            onConfigSaved = { /* config saved to SharedPreferences via bridge */ },
            onSetSystemBarColor = { colorHex -> setSystemBarColor(colorHex) },
            onAuthTokenReceived = { token ->
                android.util.Log.d("Memini", "Auth token received from JS bridge, starting NotificationService")
                PushRegistrationHelper.registerCurrentToken(this, token)
                startNotificationService()
            },
            onAuthTokenCleared = { oldToken ->
                android.util.Log.d("Memini", "Auth token cleared from JS bridge, stopping NotificationService")
                PushRegistrationHelper.unregisterInstallation(this, oldToken)
                NotificationService.stop(this)
            },
            onSetWsServiceEnabled = { enabled ->
                prefs.websocketServiceEnabled = enabled
                android.util.Log.d("Memini", "Native WS service enabled set to $enabled")
                if (enabled) {
                    startNotificationService()
                } else {
                    NotificationService.stop(this)
                }
            },
            onCheckPermission = { name -> checkAndroidPermission(name) },
            onRequestPermission = { name -> requestAndroidPermission(name) },
            onGetWsServiceStatus = { NotificationService.isActive() }
        )

        webView.addJavascriptInterface(bridge, "MeminiNative")

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true

            // Allow the WebView to render at native density
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = true
            }

            userAgentString = "$userAgentString MeminiBridge/1.0"
        }

        webView.clearCache(true)
        webView.clearHistory()

        // Enable cookies (auth token)
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // Inject bridge as early as possible
                injectBridge()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // Re-inject after page finishes (in case DOMContentLoaded already fired)
                injectBridge()
                // Extract auth token after bridge is ready
                extractAuthTokenFromWebPage()

                // Sync system bar color from the actual rendered theme
                syncSystemBarColorFromPage()

                // Mark page as loaded
                pageLoaded = true

                // If there's a pending notification from a tap, inject it now
                val pendingMsg = pendingNotificationMessage
                val pendingTitle = pendingNotificationTitle
                val pendingSessionId = pendingNotificationSessionId
                if (pendingMsg != null) {
                    pendingNotificationMessage = null
                    pendingNotificationTitle = null
                    pendingNotificationSessionId = null
                    // Delay slightly to ensure JS modules are initialized
                    webView.postDelayed({
                        injectNotificationMessage(pendingTitle ?: "Memini", pendingMsg, pendingSessionId)
                    }, 1500)
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false

                // Handle meminibridge:// custom scheme
                if (url.scheme == "meminibridge") {
                    if (url.host == "settings") {
                        openSettings()
                    }
                    return true
                }

                // External links: open in browser
                val serverHost = Uri.parse(resolveServerUrl()).host
                if (url.host != null && url.host != serverHost) {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    return true
                }

                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val resources = request.resources
                // Handle audio capture permission for voice input
                if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity, Manifest.permission.RECORD_AUDIO
                        ) == PackageManager.PERMISSION_GRANTED
                    ) {
                        request.grant(resources)
                    } else {
                        pendingWebPermission = request
                        audioPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                } else {
                    super.onPermissionRequest(request)
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: android.webkit.ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // Cancel any previous callback to avoid WebView crash
                fileChooserCallback?.onReceiveValue(arrayOf())
                fileChooserCallback = null

                // Detect if the input has capture attribute (camera mode)
                if (fileChooserParams.isCaptureEnabled) {
                    // Camera capture requested
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        launchCameraCapture(filePathCallback)
                    } else {
                        pendingCameraChooserParams = fileChooserParams
                        pendingCameraFilePathCallback = filePathCallback
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                    return true
                }

                // Normal file picker
                fileChooserCallback = filePathCallback
                try {
                    val intent = fileChooserParams.createIntent()
                    fileChooserLauncher.launch(
                        Intent.createChooser(intent, "Alege fișier")
                    )
                } catch (e: Exception) {
                    fileChooserCallback?.onReceiveValue(arrayOf())
                    fileChooserCallback = null
                    return false
                }
                return true
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Camera capture helper
    // ══════════════════════════════════════════════════════════════════

    private fun launchCameraCapture(filePathCallback: android.webkit.ValueCallback<Array<Uri>>) {
        fileChooserCallback = filePathCallback
        try {
            val timeStamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val storageDir = getExternalFilesDir(Environment.DIRECTORY_PICTURES)
            val photoFile = File.createTempFile("MEMINI_${timeStamp}_", ".jpg", storageDir)
            cameraPhotoUri = FileProvider.getUriForFile(
                this, "${packageName}.fileprovider", photoFile
            )
            val cameraIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
            }
            fileChooserLauncher.launch(cameraIntent)
        } catch (e: Exception) {
            e.printStackTrace()
            fileChooserCallback?.onReceiveValue(arrayOf())
            fileChooserCallback = null
            cameraPhotoUri = null
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Bridge injection
    // ══════════════════════════════════════════════════════════════════

    private fun injectBridge() {
        val script = NativeBridge.buildBridgeScript(
            prefs = prefs,
            wifiHelper = wifiHelper,
            biometricAvailable = biometricHelper.isAvailable
        )
        webView.evaluateJavascript(script, null)
    }

    // ══════════════════════════════════════════════════════════════════
    //  URL resolution
    // ══════════════════════════════════════════════════════════════════

    /** Determines the active server URL based on current WiFi. */
    private fun resolveServerUrl(): String {
        val onHome = wifiHelper.isOnHomeWifi(prefs.homeWifi)
        val preferred = if (onHome) prefs.localUrl else prefs.externalUrl
        val fallback = if (onHome) prefs.externalUrl else prefs.localUrl
        return if (preferred.isNotBlank()) preferred else fallback
    }

    private fun loadServerUrl() {
        val url = resolveServerUrl()
        if (url.isNotBlank()) {
            webView.loadUrl(url)
            // Try to get auth token from web page after it loads
            webView.post {
                extractAuthTokenFromWebPage()
            }
        } else {
            openSettings()
        }
    }

    private var tokenExtractionScheduled = false

    private fun extractAuthTokenFromWebPage() {
        // Debounce: only run extraction once per page load cycle
        if (tokenExtractionScheduled) return
        tokenExtractionScheduled = true

        // Try to retrieve auth token from web page's localStorage
        val script = """
            (function() {
                try {
                    var token = localStorage.getItem('memini_token');
                    if (token && window.__saveNativeAuthToken) {
                        window.__saveNativeAuthToken(token);
                        return 'saved';
                    }
                    return token ? 'no_bridge' : 'no_token';
                } catch (e) { return 'error:' + e.message; }
            })();
        """.trimIndent()

        webView.evaluateJavascript(script) { result ->
            android.util.Log.d("Memini", "Token extraction result: $result")
        }

        // Retry after page fully loads (single attempt, then start service once)
        webView.postDelayed({
            tokenExtractionScheduled = false
            webView.evaluateJavascript(script) { result ->
                android.util.Log.d("Memini", "Token extraction retry result: $result")
            }
            // After token is synced, start notification service (only once)
            webView.postDelayed({
                startNotificationService()
            }, 500)
        }, 3000)
    }

    // ══════════════════════════════════════════════════════════════════
    //  Foreground Service for push notifications
    // ══════════════════════════════════════════════════════════════════

    /**
     * Start (or restart) the foreground notification service.
     * The service maintains a persistent WebSocket connection so
     * notifications arrive even when the app is in the background.
     */
    private fun startNotificationService() {
        val token = prefs.authToken
        if (!prefs.websocketServiceEnabled) {
            android.util.Log.d("Memini", "NotificationService disabled by native preference")
            NotificationService.stop(this)
            return
        }
        if (token.isNotBlank()) {
            android.util.Log.d("Memini", "Starting NotificationService (token=${token.take(10)}...)")
            PushRegistrationHelper.registerCurrentToken(this, token)
            NotificationService.start(this)
        } else {
            android.util.Log.d("Memini", "No auth token yet — NotificationService deferred")
        }
    }

    override fun onResume() {
        super.onResume()
        // If token already exists, ensure the notification service is running again.
        if (prefs.authToken.isNotBlank()) {
            startNotificationService()
        } else {
            webView.post {
                extractAuthTokenFromWebPage()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // Service keeps running in background — nothing to do here
    }

    // ══════════════════════════════════════════════════════════════════
    //  Biometric
    // ══════════════════════════════════════════════════════════════════

    private fun proceedAfterBiometric() {
        pendingBiometric = false
        webView.visibility = View.VISIBLE
        loadServerUrl()
    }

    // ══════════════════════════════════════════════════════════════════
    //  Settings
    // ══════════════════════════════════════════════════════════════════

    private fun openSettings() {
        val intent = Intent(this, SettingsActivity::class.java)
        settingsLauncher.launch(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "meminibridge" && uri.host == "settings") {
            openSettings()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Notification tap handling → shows message in chat
    // ══════════════════════════════════════════════════════════════════

    /**
     * When user taps a notification, the intent contains the message.
     * We inject JS into the WebView to show it as a chat bubble.
     * If the page isn't loaded yet, we save it for later injection.
     */
    private fun handleNotificationIntent(intent: Intent?) {
        if (intent?.getBooleanExtra("from_notification", false) != true) return
        val message = intent.getStringExtra("notification_message") ?: return
        val title = intent.getStringExtra("notification_title") ?: "Memini"
        val sessionId = intent.getStringExtra("notification_session_id")

        // Clear the flag so we don't re-process on config change
        intent.removeExtra("from_notification")

        android.util.Log.d("Memini", "Notification tap: title=$title, message=${message.take(80)}, session=$sessionId")

        if (pageLoaded) {
            // Page is ready — inject now
            injectNotificationMessage(title, message, sessionId)
        } else {
            // Page not ready — save for injection after page load
            pendingNotificationTitle = title
            pendingNotificationMessage = message
            pendingNotificationSessionId = sessionId
        }
    }

    private fun injectNotificationMessage(title: String, message: String, sessionId: String? = null) {
        val escapedMessage = message
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "")
        val escapedTitle = title
            .replace("\\", "\\\\")
            .replace("'", "\\'")
        val escapedSessionId = sessionId?.let {
            it.replace("\\", "\\\\").replace("'", "\\'")
        }
        val sessionArg = if (escapedSessionId != null) "'$escapedSessionId'" else "null"

        webView.post {
            webView.evaluateJavascript(
                """(function() {
                    // Store pending notification data for the web app to pick up
                    window.__pendingMeminiNotification = {
                        title: '$escapedTitle',
                        message: '$escapedMessage',
                        sessionId: $sessionArg
                    };
                    // Try to deliver immediately, or poll until JS modules are loaded
                    var attempts = 0;
                    function tryDeliver() {
                        if (typeof window.__meminiShowNotification === 'function') {
                            window.__meminiShowNotification('$escapedTitle', '$escapedMessage', $sessionArg);
                            delete window.__pendingMeminiNotification;
                        } else if (attempts < 20) {
                            attempts++;
                            setTimeout(tryDeliver, 500);
                        }
                    }
                    tryDeliver();
                })();""".trimIndent(),
                null
            )
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  Cache
    // ══════════════════════════════════════════════════════════════════

    private fun clearWebViewCache() {
        webView.clearCache(true)
        webView.clearFormData()
        CookieManager.getInstance().removeAllCookies(null)
    }

    // ══════════════════════════════════════════════════════════════════
    //  System bar colors (dynamic, set by web UI)
    // ══════════════════════════════════════════════════════════════════

    private fun setSystemBarColor(colorHex: String) {
        try {
            val color = android.graphics.Color.parseColor(colorHex)
            @Suppress("DEPRECATION")
            window.statusBarColor = color
            @Suppress("DEPRECATION")
            window.navigationBarColor = color
            // Also update contentRoot background so the padded area
            // (behind status/nav bars) matches the active theme
            contentRoot.setBackgroundColor(color)
            // Switch status/nav bar icon color based on background luminance
            val luminance = androidx.core.graphics.ColorUtils.calculateLuminance(color)
            val isLight = luminance > 0.5
            WindowInsetsControllerCompat(window, window.decorView).apply {
                isAppearanceLightStatusBars = isLight
                isAppearanceLightNavigationBars = isLight
            }
            // Persist so next onCreate uses the correct color instantly
            prefs.themeColor = colorHex
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Read --meta-theme-color from the live page CSS and apply it.
     * Called from onPageFinished — the single source of truth is the CSS,
     * so this works regardless of JS timing or bridge injection order.
     */
    private fun syncSystemBarColorFromPage() {
        webView.evaluateJavascript(
            "getComputedStyle(document.documentElement).getPropertyValue('--meta-theme-color').trim()",
            { result ->
                // evaluateJavascript returns a JSON-encoded string: "\"#030712\""
                val color = result?.trim()?.removeSurrounding("\"")
                if (!color.isNullOrBlank() && color.startsWith("#")) {
                    runOnUiThread { setSystemBarColor(color) }
                }
            }
        )
    }

    // ══════════════════════════════════════════════════════════════════
    //  Back navigation (WebView history)
    // ══════════════════════════════════════════════════════════════════

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onDestroy() {
        // Service keeps running — do NOT stop it on activity destroy
        // User can stop it via Settings or app force-stop
        super.onDestroy()
    }
}
