plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

/**
 * Backend base URL is injected at build time — never hard-coded in source, and
 * never a secret: the app holds no shared key. It authenticates with a device
 * JWT obtained at runtime via OTP, so a decompiled APK yields no credentials.
 */
fun prop(name: String, fallback: String): String =
    (project.findProperty(name) as String?)?.trim().takeUnless { it.isNullOrEmpty() } ?: fallback

val releaseBaseUrl = prop("darslyApiBaseUrl", "https://api.darsly.app/api/v1/")
val debugBaseUrl = prop("darslyApiBaseUrlDebug", "http://10.0.2.2:4000/api/v1/")

android {
    namespace = "com.darsly.smslistener"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.darsly.smslistener"
        // 26 (Android 8.0): adaptive launcher icons + notification channels without
        // legacy fallbacks, and it is the floor for the background-execution model
        // this app is designed around. Private distribution to known handsets.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"$debugBaseUrl\"")
            // Cleartext to a LAN/emulator backend is allowed in debug only — see
            // network_security_config.xml, which permits it for debug builds.
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "API_BASE_URL", "\"$releaseBaseUrl\"")
        }
    }

    // HTTPS-only in release. Fail the build rather than ship a listener that
    // would post financial SMS over cleartext.
    afterEvaluate {
        tasks.matching { it.name.contains("Release") && it.name.startsWith("assemble") }.configureEach {
            doFirst {
                require(releaseBaseUrl.startsWith("https://")) {
                    "darslyApiBaseUrl must be https:// for release builds (got: $releaseBaseUrl)"
                }
                require(releaseBaseUrl.endsWith("/")) {
                    "darslyApiBaseUrl must end with a trailing slash (got: $releaseBaseUrl)"
                }
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = libs.versions.composeCompiler.get()
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.coroutines.android)

    // UI
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    debugImplementation(libs.compose.ui.tooling)

    // Local store (outbox)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Backend
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    // Background sync
    implementation(libs.androidx.work.runtime)

    // Keystore-backed token storage
    implementation(libs.androidx.security.crypto)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.retrofit)
    testImplementation(libs.retrofit.serialization)
    testImplementation(libs.kotlinx.serialization.json)

    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.room.testing)
}
