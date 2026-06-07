package com.example.hyve

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * Manages biometric authentication (fingerprint / Face ID) on app launch.
 */
class BiometricHelper(private val activity: FragmentActivity) {

    /** Whether the device supports biometric authentication. */
    val isAvailable: Boolean
        get() {
            val mgr = BiometricManager.from(activity)
            return mgr.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
                    BiometricManager.BIOMETRIC_SUCCESS
        }

    /**
     * Shows the biometric prompt. Calls [onSuccess] on authentication,
     * [onFailure] if cancelled or failed.
     */
    fun authenticate(onSuccess: () -> Unit, onFailure: () -> Unit) {
        val executor = ContextCompat.getMainExecutor(activity)

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                super.onAuthenticationSucceeded(result)
                onSuccess()
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                super.onAuthenticationError(errorCode, errString)
                if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                ) {
                    onFailure()
                } else {
                    // Hardware error or lockout — let the user through
                    onSuccess()
                }
            }

            override fun onAuthenticationFailed() {
                // Single attempt failed, prompt stays open — do nothing
            }
        }

        val prompt = BiometricPrompt(activity, executor, callback)

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Hyve")
            .setSubtitle("Autentificare biometrică")
            .setNegativeButtonText("Anulează")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build()

        prompt.authenticate(info)
    }
}
