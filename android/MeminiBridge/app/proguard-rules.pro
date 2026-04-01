# Add project specific ProGuard rules here.
# Keep the JavaScript interface methods
-keepclassmembers class com.example.meminibridge.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep AppPreferences for SharedPreferences
-keep class com.example.meminibridge.AppPreferences { *; }

# OkHttp (WebSocket client)
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Keep WebSocketClient, NotificationHelper and NotificationService
-keep class com.example.meminibridge.WebSocketClient { *; }
-keep class com.example.meminibridge.NotificationHelper { *; }
-keep class com.example.meminibridge.NotificationService { *; }
-keep class com.example.meminibridge.ReminderBroadcastReceiver { *; }
