# Add project specific ProGuard rules here.
# Keep the JavaScript interface methods
-keepclassmembers class com.example.hyve.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep AppPreferences for SharedPreferences
-keep class com.example.hyve.AppPreferences { *; }

# OkHttp (WebSocket client)
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# Keep WebSocketClient, NotificationHelper and NotificationService
-keep class com.example.hyve.WebSocketClient { *; }
-keep class com.example.hyve.NotificationHelper { *; }
-keep class com.example.hyve.NotificationService { *; }
-keep class com.example.hyve.ReminderBroadcastReceiver { *; }
