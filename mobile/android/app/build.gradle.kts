import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Backend address: set in mobile/android/local.properties (not committed)
//   promptflow.supabaseUrl=https://xxxx.supabase.co
//   promptflow.supabaseAnonKey=eyJ...
// or as environment variables of the same names in CI. Also editable in-app.
val local = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
// The hosted PromptFlow backend. Both values are public by design (the key
// only allows what row-level security permits).
val defaults = mapOf(
    "supabaseUrl" to "https://fhslwvrspzdcvokajvno.supabase.co",
    "supabaseAnonKey" to "sb_publishable_havZ6UNdxBtt0AtqpBZaaw_Y_lr8Lss",
)

fun cfg(name: String): String =
    listOf(local.getProperty("promptflow.$name"), System.getenv("PROMPTFLOW_${name.uppercase()}"))
        .firstOrNull { !it.isNullOrBlank() } ?: defaults[name].orEmpty()

android {
    namespace = "com.akhil.promptflow"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.akhil.promptflow"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "SUPABASE_URL", "\"${cfg("supabaseUrl")}\"")
        buildConfigField("String", "SUPABASE_ANON_KEY", "\"${cfg("supabaseAnonKey")}\"")
    }

    // A fixed debug key (not a secret: it's Android's standard debug identity)
    // so each CI build installs over the last one without uninstalling.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions { unitTests.isReturnDefaultValues = true }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.07.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
