plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.google.services) apply false
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.example.hyve"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.hyve"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.9.8.5"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
}
