# YuxTrans 安卓端 v1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库内新建 `android/` 独立 Gradle 项目，实现 v1：全局划词悬浮窗翻译 + 内置浏览器整页翻译，同时移除 Python 包。

**Architecture:** 单 App 无后端，Kotlin + Jetpack Compose。`core/` 纯 Kotlin 翻译引擎（供应商适配、SSE 流式、缓存、限速、批量降级，全部移植自 `extension/background.js` 与 `extension/lib/sw/`），Android 壳层为 CaptureService（无障碍）/ OverlayService（悬浮窗）/ Compose UI / WebView 整页翻译。

**Tech Stack:** Kotlin 2.0、AGP 8.x、Jetpack Compose（BOM 2024.09+）、OkHttp 4.12、kotlinx-serialization-json、Room 2.6、DataStore、security-crypto；测试 JUnit4 + MockWebServer + kotlinx-coroutines-test。

**Spec:** `docs/superpowers/specs/2026-07-22-android-app-design.md`（所有领域规则的权威来源；移植参照源为 `extension/background.js`、`extension/lib/sw/*.js`、`extension/content.js`）。

**包名约定：** `com.yuxtrans.app`，源码根 `android/app/src/main/java/com/yuxtrans/app/`，下文一律用相对路径如 `core/CacheKeys.kt` 指代该根下的文件；测试根 `android/app/src/test/java/com/yuxtrans/app/`。

---

### Task 0: 环境准备（用户手动，一次性）

当前机器无 Android SDK、无 Gradle，仅有 Java 25（过新，AGP 不兼容）。

- [ ] **Step 1: 安装 Android Studio**

下载安装 Android Studio（https://developer.android.com/studio），首次启动向导中安装：Android SDK Platform 35、Android SDK Build-Tools、Android SDK Command-line Tools。Android Studio 自带 JBR 17，Gradle 会用它而不是系统的 Java 25。

- [ ] **Step 2: 验证环境**

Run: `ls ~/AppData/Local/Android/Sdk/platforms`
Expected: 存在 `android-35` 或更新版本目录。

### Task 1: 仓库清理（移除 Python 包）

**Files:**
- Delete: `yuxtrans/`, `tests/`, `examples/`, `benchmark/`, `pyproject.toml`, `requirements.txt`, `pytest.ini`, `.pytest_cache/`, `.ruff_cache/`, `.tmp-venv/`
- Modify: `AGENTS.md`, `README.md`, `CHANGELOG.md`, `CONTEXT.md`

- [ ] **Step 1: 删除 Python 相关文件**

```bash
git rm -r yuxtrans/ tests/ examples/ benchmark/ pyproject.toml requirements.txt pytest.ini
rm -rf .pytest_cache/ .ruff_cache/ .tmp-venv/
```

- [ ] **Step 2: 更新 CONTEXT.md**

边界上下文一节删除「Python Package」条目，替换为：

```markdown
- **Android App**：`android/` 目录下的原生应用（Kotlin + Compose），复用扩展的领域逻辑：全局划词悬浮窗翻译（v1）、内置浏览器整页翻译（v1）、全局屏幕翻译（v1.1 规划）。
```

- [ ] **Step 3: 更新 AGENTS.md**

- 项目概述：删除「Python 包」一条，复合项目改为「浏览器扩展 + 安卓 App」双端；版本号删除 Python 包版本。
- 仓库结构树：删除 `yuxtrans/`、`tests/`、`examples/`、`pyproject.toml` 等条目，新增 `android/`（标注「安卓 App，Kotlin + Compose，独立 Gradle 项目」）和 `docs/superpowers/`（设计与计划文档）。
- 删除章节：3 技术栈的「Python 侧」、4.1 Python 翻译引擎、5.1 Python 包安装、6.1/6.2 Python 测试与 ruff、8.1 Python 配置、10 供应商扩展的「Python 侧」小节、12 备忘的第 1/2/4 条中 Python 相关部分。
- 新增「安卓侧」技术栈小节：Kotlin 2.0、Compose、OkHttp、Room、DataStore；测试 `./gradlew test`（在 `android/` 目录下）。
- 第 10 节标题改为「如何扩展新云端供应商」，内容改为需同步 `extension/background.js`、`extension/options.js`、`extension/manifest.json` 与 `android/app/src/main/java/com/yuxtrans/app/core/Constants.kt` 四处。
- 结构注意事项：改为「根目录 `.git` 是唯一版本控制入口；`android/` 是独立 Gradle 项目，不依赖扩展构建」。

- [ ] **Step 4: 更新 README.md 与 CHANGELOG.md**

README：删除 Python 安装/使用章节，项目简介改为「浏览器扩展 + 安卓 App」。CHANGELOG 新增条目：

```markdown
## [Unreleased]
### Removed
- 移除 Python 包（yuxtrans/、tests/、examples/、benchmark/ 及相关配置），项目聚焦浏览器扩展与安卓 App。
### Added
- 新增安卓端设计文档 docs/superpowers/specs/2026-07-22-android-app-design.md 与实现计划。
```

- [ ] **Step 5: 验证扩展测试仍通过**

Run: `node --test extension/tests/`
Expected: `55 passed`（清理不影响扩展）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove python package, refocus repo on extension and android app"
```

### Task 2: Gradle 项目骨架

**Files:**
- Create: `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/app/build.gradle.kts`, `android/app/proguard-rules.pro`, `android/app/src/main/AndroidManifest.xml`
- Create: `android/local.properties`（不提交，含 SDK 路径）
- Create: `MainActivity.kt`（空壳）、`YuxTransApp.kt`（Application）

- [ ] **Step 1: 写根构建文件**

`android/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "yuxtrans-android"
include(":app")
```

`android/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
    id("com.google.devtools.ksp") version "2.0.21-1.0.28" apply false
}
```

`android/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
android.nonTransitiveRClass=true
```

`android/local.properties`（加入 `.gitignore`，内容为 SDK 实际路径）:

```properties
sdk.dir=C:\\Users\\Administrator\\AppData\\Local\\Android\\Sdk
```

- [ ] **Step 2: 写 app 模块构建文件**

`android/app/build.gradle.kts`:

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.yuxtrans.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yuxtrans.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("io.mockk:mockk:1.13.13")
}
```

`android/app/proguard-rules.pro`:

```proguard
-keepclassmembers class com.yuxtrans.app.data.** { *; }
-dontwarn org.bouncycastle.**
```

- [ ] **Step 3: 写 AndroidManifest.xml 与空壳入口**

`android/app/src/main/AndroidManifest.xml`（后续任务会往里加 service/activity，此处先给完整骨架）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />

    <application
        android:name=".YuxTransApp"
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:theme="@style/Theme.YuxTrans"
        android:supportsRtl="true">

        <activity
            android:name=".ui.MainActivity"
            android:exported="true"
            android:theme="@style/Theme.YuxTrans">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

`android/app/src/main/res/values/strings.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">YuxTrans</string>
</resources>
```

`android/app/src/main/res/values/themes.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.YuxTrans" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
```

`YuxTransApp.kt`:

```kotlin
package com.yuxtrans.app

import android.app.Application

class YuxTransApp : Application()
```

`ui/MainActivity.kt`（空壳，Task 18 替换）:

```kotlin
package com.yuxtrans.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Text("YuxTrans") }
    }
}
```

启动图标：复用 `logo/logo.png`，用 Android Studio 的 Image Asset Studio 生成 `mipmap` 各密度图标（手动步骤；或先注释掉 manifest 的 `android:icon` 行使用默认）。

- [ ] **Step 4: 生成 Gradle Wrapper 并首次构建**

用 Android Studio 打开 `android/` 目录，让它生成 wrapper 并完成首次 sync；或若已装 gradle：

Run: `cd android && gradle wrapper --gradle-version 8.10.2 && ./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL`，产出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 5: 更新根 .gitignore 并 Commit**

`.gitignore` 追加：

```gitignore
# Android
android/.gradle/
android/local.properties
android/**/build/
android/.idea/
*.iml
```

```bash
git add -A
git commit -m "feat(android): scaffold gradle project with compose, room, okhttp"
```

### Task 3: 核心数据模型与常量

**Files:**
- Create: `core/Models.kt`
- Create: `core/Constants.kt`
- Test: `core/ConstantsTest.kt`

- [ ] **Step 1: 写失败测试**

`core/ConstantsTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConstantsTest {
    @Test
    fun `endpoints contain all cloud providers`() {
        assertTrue(Constants.API_ENDPOINTS["qwen"]!!.contains("dashscope"))
        assertTrue(Constants.API_ENDPOINTS["openai"]!!.contains("api.openai.com"))
        assertEquals(7, Constants.API_ENDPOINTS.size) // 无 local
    }

    @Test
    fun `default models first entry matches extension defaults`() {
        assertEquals("qwen-turbo", Constants.DEFAULT_MODELS["qwen"]!!.first())
        assertEquals("gpt-4o", Constants.DEFAULT_MODELS["openai"]!!.first())
    }

    @Test
    fun `json mode providers exclude anthropic`() {
        assertTrue("openai" in Constants.JSON_MODE_PROVIDERS)
        assertTrue("anthropic" !in Constants.JSON_MODE_PROVIDERS)
    }
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.ConstantsTest"`
Expected: FAIL（`Constants` 未定义，编译错误）

- [ ] **Step 3: 写实现**

`core/Models.kt`:

```kotlin
package com.yuxtrans.app.core

enum class ProviderFormat { OPENAI, ANTHROPIC }

data class ProviderProfile(
    val id: String,
    val provider: String,
    val apiKey: String = "",
    val endpoint: String = "",
    val model: String = "",
    val format: ProviderFormat? = null // 仅 custom 供应商使用
)

data class ActiveConfig(
    val activeProfileId: String = "",
    val sourceLang: String = "auto",
    val targetLang: String = "zh",
    val translateStyle: String = "normal",
    val bilingualMode: Boolean = true,
    val appBlacklist: Set<String> = emptySet(),
    val maxCacheMB: Int = 50,
    val maxCacheEntries: Int = 5000
)

data class TranslationRequest(
    val text: String,
    val sourceLang: String = "auto",
    val targetLang: String = "zh",
    val style: String = "normal"
)

data class TranslationResult(
    val text: String,
    val engine: String,
    val cached: Boolean = false
)

class TranslationError(
    message: String,
    val engine: String,
    cause: Throwable? = null
) : Exception(message, cause)
```

`core/Constants.kt`（数值与扩展 `extension/lib/sw/constants.js:9-75`、`extension/background.js:102-112` 一一对应）:

```kotlin
package com.yuxtrans.app.core

object Constants {
    val API_ENDPOINTS = mapOf(
        "qwen" to "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "openai" to "https://api.openai.com/v1/chat/completions",
        "deepseek" to "https://api.deepseek.com/v1/chat/completions",
        "anthropic" to "https://api.anthropic.com/v1/messages",
        "groq" to "https://api.groq.com/openai/v1/chat/completions",
        "moonshot" to "https://api.moonshot.cn/v1/chat/completions",
        "siliconflow" to "https://api.siliconflow.cn/v1/chat/completions"
    )

    val DEFAULT_MODELS = mapOf(
        "qwen" to listOf("qwen-turbo", "qwen-plus", "qwen-max", "qwen-max-longcontext"),
        "openai" to listOf("gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"),
        "deepseek" to listOf("deepseek-chat", "deepseek-v4-flash", "deepseek-v4-pro"),
        "anthropic" to listOf("claude-3-5-sonnet-latest", "claude-3-5-haiku-latest", "claude-3-opus-latest"),
        "groq" to listOf("llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"),
        "moonshot" to listOf("moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"),
        "siliconflow" to listOf(
            "Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V2.5"
        )
    )

    val JSON_MODE_PROVIDERS = setOf("openai", "qwen", "deepseek", "groq", "moonshot", "siliconflow")

    val STYLE_PROMPTS = mapOf(
        "normal" to "",
        "academic" to "Use an academic and formal style with precise terminology.",
        "technical" to "Preserve technical accuracy, keep technical terms and code references intact.",
        "literary" to "Use literary elegance and artistic expression."
    )

    val LANG_NAMES = mapOf(
        "zh" to "Simplified Chinese", "zh-TW" to "Traditional Chinese",
        "en" to "English", "ja" to "Japanese", "ko" to "Korean",
        "fr" to "French", "de" to "German", "es" to "Spanish",
        "ru" to "Russian", "pt" to "Portuguese", "it" to "Italian",
        "ar" to "Arabic", "th" to "Thai", "vi" to "Vietnamese"
    )

    const val CACHE_KEY_VERSION = "v3"
    const val PROMPT_VERSION = "p1"
    const val MIN_CACHE_SOURCE_LENGTH = 12
    const val CLOUD_TIMEOUT_MS = 30_000L
    const val STREAM_TIMEOUT_MS = 60_000L
    const val MAX_BATCH_CHARS = 4000
    const val DEFAULT_BATCH_SIZE = 20
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.ConstantsTest"`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): add core models and provider constants"
```

### Task 4: 缓存键（CacheKeys）

**Files:**
- Create: `core/CacheKeys.kt`
- Test: `core/CacheKeysTest.kt`

移植源：`extension/lib/sw/cache-keys.js:14-72`。键格式：`v3:p1:<modelSlug>:<src>:<tgt>:<style>:<归一化文本>`，无哈希。

- [ ] **Step 1: 写失败测试**

`core/CacheKeysTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CacheKeysTest {
    @Test
    fun `normalize collapses whitespace and strips zero-width chars`() {
        assertEquals("a b", CacheKeys.normalizeText("  a   b  "))
        assertEquals("ab", CacheKeys.normalizeText("a​b﻿"))
    }

    @Test
    fun `key without model uses underscore placeholder`() {
        val key = CacheKeys.generateKey("hello", "en", "zh", "normal", "")
        assertEquals("v3:p1:_:en:zh:normal:hello", key)
    }

    @Test
    fun `model slug replaces colon so qwen2-7b does not break segments`() {
        assertEquals("qwen2-7b", CacheKeys.modelSlug("qwen2:7b"))
        val key = CacheKeys.generateKey("hi there friend", "auto", "zh", "normal", "qwen2:7b")
        val parsed = CacheKeys.parseKey(key)!!
        assertEquals("qwen2-7b", parsed.modelSlug)
        assertEquals("hi there friend", parsed.text)
    }

    @Test
    fun `different models produce different keys`() {
        val a = CacheKeys.generateKey("hello world", "en", "zh", "normal", "gpt-4o")
        val b = CacheKeys.generateKey("hello world", "en", "zh", "normal", "qwen-turbo")
        assert(a != b)
    }

    @Test
    fun `parseKey returns null for wrong version`() {
        assertNull(CacheKeys.parseKey("v2:p1:_:en:zh:normal:hello"))
    }

    @Test
    fun `text containing colons survives round trip`() {
        val key = CacheKeys.generateKey("time: 10:30 now", "en", "zh", "normal", "")
        assertEquals("time: 10:30 now", CacheKeys.parseKey(key)!!.text)
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.CacheKeysTest"`
Expected: FAIL（编译错误，`CacheKeys` 未定义）

- [ ] **Step 3: 写实现**

`core/CacheKeys.kt`:

```kotlin
package com.yuxtrans.app.core

import java.text.Normalizer

object CacheKeys {
    data class ParsedKey(
        val version: String,
        val promptVersion: String,
        val modelSlug: String,
        val sourceLang: String,
        val targetLang: String,
        val style: String,
        val text: String
    )

    private val ZERO_WIDTH = Regex("[​-‏﻿]")

    fun normalizeText(text: String?): String {
        if (text.isNullOrEmpty()) return ""
        return Normalizer.normalize(text, Normalizer.Form.NFC)
            .replace(ZERO_WIDTH, "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    fun modelSlug(model: String?): String {
        if (model.isNullOrEmpty()) return "_"
        val slug = model
            .replace(Regex("[^a-zA-Z0-9._-]"), "-")
            .replace(Regex("-+"), "-")
            .trim('-')
        return slug.take(64).ifEmpty { "_" }
    }

    fun generateKey(
        text: String,
        sourceLang: String,
        targetLang: String,
        style: String?,
        model: String?
    ): String {
        val resolvedStyle = style ?: "normal"
        return "${Constants.CACHE_KEY_VERSION}:${Constants.PROMPT_VERSION}:" +
            "${modelSlug(model)}:$sourceLang:$targetLang:$resolvedStyle:${normalizeText(text)}"
    }

    fun parseKey(key: String): ParsedKey? {
        val parts = key.split(":")
        if (parts.size < 7) return null
        if (parts[0] != Constants.CACHE_KEY_VERSION) return null
        return ParsedKey(
            version = parts[0],
            promptVersion = parts[1],
            modelSlug = parts[2],
            sourceLang = parts[3],
            targetLang = parts[4],
            style = parts[5],
            text = parts.subList(6, parts.size).joinToString(":")
        )
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.CacheKeysTest"`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): port cache key generation and normalization"
```

### Task 5: 语言检测（LangDetect）

**Files:**
- Create: `core/LangDetect.kt`
- Test: `core/LangDetectTest.kt`

移植源：`extension/lib/sw/lang.js:26-55`（前 500 字符按 Unicode script 计数打分）与 `extension/background.js` 批量翻译的同语种翻转逻辑。

- [ ] **Step 1: 写失败测试**

`core/LangDetectTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class LangDetectTest {
    @Test
    fun `detects chinese english japanese korean`() {
        assertEquals("zh", LangDetect.detect("这是一个中文句子，用于测试语言检测。"))
        assertEquals("en", LangDetect.detect("This is an English sentence for detection."))
        assertEquals("ja", LangDetect.detect("これは日本語のテスト文章です。"))
        assertEquals("ko", LangDetect.detect("이것은 한국어 테스트 문장입니다."))
    }

    @Test
    fun `detects cyrillic arabic thai`() {
        assertEquals("ru", LangDetect.detect("Это русское предложение для проверки."))
        assertEquals("ar", LangDetect.detect("هذه جملة عربية للاختبار"))
        assertEquals("th", LangDetect.detect("นี่คือประโยคภาษาไทยสำหรับการทดสอบ"))
    }

    @Test
    fun `unknown for empty or punctuation only`() {
        assertEquals("unknown", LangDetect.detect(""))
        assertEquals("unknown", LangDetect.detect("12345 !!!!"))
    }

    @Test
    fun `flipOpposite maps per extension opposite map`() {
        assertEquals("en", LangDetect.flipOpposite("zh", "zh"))
        assertEquals("zh", LangDetect.flipOpposite("en", "zh"))
        assertEquals("zh", LangDetect.flipOpposite("ja", "zh"))
        assertEquals("en", LangDetect.flipOpposite("ru", "ru"))
        assertEquals("fr", LangDetect.flipOpposite("fr", "zh")) // 不在翻转表中则保持
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.LangDetectTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/LangDetect.kt`:

```kotlin
package com.yuxtrans.app.core

object LangDetect {
    private const val SAMPLE_SIZE = 500

    private val HAN = Regex("\\p{IsHan}")
    private val HIRAGANA = Regex("\\p{IsHiragana}")
    private val KATAKANA = Regex("\\p{IsKatakana}")
    private val HANGUL = Regex("\\p{IsHangul}")
    private val CYRILLIC = Regex("\\p{IsCyrillic}")
    private val ARABIC = Regex("\\p{IsArabic}")
    private val THAI = Regex("\\p{IsThai}")
    private val LATIN = Regex("[a-zA-Z]")

    fun detect(text: String): String {
        val sample = text.take(SAMPLE_SIZE)
        if (sample.isBlank()) return "unknown"
        var han = 0; var hira = 0; var kata = 0; var hangul = 0
        var cyrillic = 0; var arabic = 0; var thai = 0; var latin = 0
        for (ch in sample) {
            val s = ch.toString()
            when {
                HIRAGANA.containsMatchIn(s) -> hira++
                KATAKANA.containsMatchIn(s) -> kata++
                HAN.containsMatchIn(s) -> han++
                HANGUL.containsMatchIn(s) -> hangul++
                CYRILLIC.containsMatchIn(s) -> cyrillic++
                ARABIC.containsMatchIn(s) -> arabic++
                THAI.containsMatchIn(s) -> thai++
                LATIN.containsMatchIn(s) -> latin++
            }
        }
        val total = han + hira + kata + hangul + cyrillic + arabic + thai + latin
        if (total == 0) return "unknown"
        return when {
            hira + kata > 0 && (hira + kata) * 5 >= total -> "ja"
            hangul * 2 >= total -> "ko"
            han * 2 >= total -> "zh"
            cyrillic * 2 >= total -> "ru"
            arabic * 2 >= total -> "ar"
            thai * 2 >= total -> "th"
            latin * 2 >= total -> "en"
            else -> "unknown"
        }
    }

    /** 源语 == 目标语时的翻转表，对应 background.js 的 oppositeMap */
    private val OPPOSITE = mapOf(
        "zh" to "en", "zh-TW" to "en",
        "en" to "zh", "ja" to "zh", "ko" to "zh",
        "ru" to "en", "ar" to "en", "th" to "en", "vi" to "en"
    )

    /** 源语与目标语相同则翻转，否则返回原目标语 */
    fun flipOpposite(sourceLang: String, targetLang: String): String {
        return if (sourceLang == targetLang) OPPOSITE[sourceLang] ?: "en" else targetLang
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.LangDetectTest"`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): port language detection and opposite-language flip"
```

### Task 6: 缓存校验器（CacheValidator）

**Files:**
- Create: `core/CacheValidator.kt`
- Test: `core/CacheValidatorTest.kt`

移植源：`extension/background.js:796-994`（`REFUSAL_PATTERNS`、`validateCacheEntry` 全规则、`isProperNoun`、`hasEntityDrift`、`getTargetScriptRegex`）。**`PROPER_NOUN_WHITELIST` 的 30 项完整列表从 `extension/background.js:801-806` 原样照抄**，不要凭记忆重写。

- [ ] **Step 1: 写失败测试**

`core/CacheValidatorTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CacheValidatorTest {
    private fun keyOf(text: String, src: String = "en", tgt: String = "zh") =
        CacheKeys.generateKey(text, src, tgt, "normal", "")

    @Test
    fun `rejects source shorter than 12 chars`() {
        val r = CacheValidator.validate(keyOf("short"), "短")
        assertFalse(r.valid)
        assertEquals("too_short", r.rule)
    }

    @Test
    fun `rejects refusal patterns in translation`() {
        val r = CacheValidator.validate(keyOf("translate this sentence please"), "I'm sorry, I cannot translate this.")
        assertFalse(r.valid)
        assertEquals("refusal", r.rule)
    }

    @Test
    fun `rejects echo when translation equals source`() {
        val text = "hello world foo"
        val r = CacheValidator.validate(keyOf(text), text)
        assertFalse(r.valid)
        assertEquals("echo", r.rule)
    }

    @Test
    fun `accepts proper noun echo`() {
        val r = CacheValidator.validate(keyOf("GitHub Actions"), "GitHub Actions")
        assertTrue(r.valid)
    }

    @Test
    fun `rejects cjk translation containing latin when cjk to cjk`() {
        val r = CacheValidator.validate(keyOf("这是一个足够长的中文句子", "zh", "ja"), "これはtestです")
        assertFalse(r.valid)
        assertEquals("cjk_latin_drift", r.rule)
    }

    @Test
    fun `rejects translation with low target script ratio`() {
        val r = CacheValidator.validate(keyOf("this is a fairly long english sentence"), "this is mostly english still")
        assertFalse(r.valid)
        assertEquals("target_script", r.rule)
    }

    @Test
    fun `rejects entity drift on short source`() {
        val r = CacheValidator.validate(keyOf("user profile", "en", "en"), "visit github.com/user")
        assertFalse(r.valid)
        assertEquals("entity_drift", r.rule)
    }

    @Test
    fun `rejects extreme length ratio on short source`() {
        // 源文 <=10 字符（归一化前 "hello wor" 9 字符），译文过长
        val longTranslation = "这是一个非常非常非常长的译文，明显超出了短源文的合理长度比例范围"
        val r = CacheValidator.validate(keyOf("hello world!"), longTranslation)
        assertFalse(r.valid)
    }

    @Test
    fun `accepts normal good translation`() {
        val r = CacheValidator.validate(keyOf("this is a fairly long english sentence"), "这是一个相当长的英文句子")
        assertTrue(r.valid)
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.CacheValidatorTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/CacheValidator.kt`（规则顺序与 `background.js:926-994` 一致，按序短路）:

```kotlin
package com.yuxtrans.app.core

object CacheValidator {
    data class Result(val valid: Boolean, val rule: String = "")

    // 对应 background.js:796-799，原样
    private val REFUSAL_PATTERNS = listOf(
        "i'm sorry", "as an ai", "cannot translate", "can't translate",
        "unable to", "error", "429", "rate limit", "<!doctype", "<html"
    )

    // 对应 background.js:801-806：实现时从该文件 801-806 行原样照抄完整 30 项
    private val PROPER_NOUN_WHITELIST = setOf(
        "github", "google", "openai", "api", "chatgpt", "javascript", "typescript",
        "python", "java", "rust", "golang", "linux", "windows", "macos", "ios",
        "android", "chrome", "firefox", "safari", "edge", "docker", "kubernetes",
        "react", "vue", "angular", "node", "npm", "vscode", "vs code", "stackoverflow"
        // TODO-COPY: 与 background.js:801-806 比对补全为完全一致的 30 项
    )

    private const val SHORT_SOURCE_THRESHOLD = 10
    private const val MIN_TARGET_SCRIPT_RATIO = 0.5

    private val CJK = setOf("zh", "zh-TW", "ja", "ko")
    private val LATIN_LANGS = setOf("en", "fr", "de", "es", "pt", "it")

    fun validate(cacheKey: String, translation: String): Result {
        val parsed = CacheKeys.parseKey(cacheKey) ?: return Result(false, "version_mismatch")
        val normalizedSource = CacheKeys.normalizeText(parsed.text)

        if (normalizedSource.length < Constants.MIN_CACHE_SOURCE_LENGTH) {
            return Result(false, "too_short")
        }
        val lowerTranslation = translation.lowercase()
        if (REFUSAL_PATTERNS.any { lowerTranslation.contains(it) }) {
            return Result(false, "refusal")
        }
        if (normalizedSource.length <= SHORT_SOURCE_THRESHOLD) {
            val ratio = translation.length.toDouble() / normalizedSource.length
            if (ratio > ratioThreshold(parsed.sourceLang, parsed.targetLang)) {
                return Result(false, "length_ratio")
            }
        }
        if (parsed.sourceLang != parsed.targetLang &&
            normalizedSource == CacheKeys.normalizeText(translation) &&
            !isProperNoun(normalizedSource)
        ) {
            return Result(false, "echo")
        }
        val srcCjk = parsed.sourceLang in CJK
        val tgtCjk = parsed.targetLang in CJK
        if (srcCjk && tgtCjk && translation.contains(Regex("[a-zA-Z]"))) {
            return Result(false, "cjk_latin_drift")
        }
        if (!tgtCjk || !srcCjk) {
            if (targetScriptRatio(translation, parsed.targetLang) < MIN_TARGET_SCRIPT_RATIO) {
                return Result(false, "target_script")
            }
            val detected = LangDetect.detect(sampleText(translation))
            if (detected == parsed.sourceLang && detected != "unknown") {
                return Result(false, "source_language_echo")
            }
        }
        if (normalizedSource.length <= SHORT_SOURCE_THRESHOLD && hasEntityDrift(normalizedSource, translation)) {
            return Result(false, "entity_drift")
        }
        return Result(true)
    }

    /** CJK→Latin=5，Latin→CJK=2，同语系=3（background.js:843-850） */
    private fun ratioThreshold(src: String, tgt: String): Double {
        val srcCjk = src in CJK
        val tgtCjk = tgt in CJK
        return when {
            srcCjk && !tgtCjk -> 5.0
            !srcCjk && tgtCjk -> 2.0
            else -> 3.0
        }
    }

    private fun isProperNoun(text: String): Boolean {
        val lower = text.lowercase()
        if (PROPER_NOUN_WHITELIST.any { lower.contains(it) }) return true
        val words = text.split(Regex("\\s+"))
        if (words.size == 1) {
            val w = words[0]
            return w.firstOrNull()?.isUpperCase() == true || w.all { it.isUpperCase() || it.isDigit() }
        }
        return words.all { it.firstOrNull()?.isUpperCase() == true }
    }

    /** >200 字符时取头/中/尾各 100 字符采样（background.js:882-890） */
    private fun sampleText(text: String): String {
        if (text.length <= 200) return text
        val mid = text.length / 2
        return text.take(100) + text.substring(mid - 50, mid + 50) + text.takeLast(100)
    }

    private fun targetScriptRegex(lang: String): Regex = when (lang) {
        "zh", "zh-TW" -> Regex("\\p{IsHan}")
        "ja" -> Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}]")
        "ko" -> Regex("\\p{IsHangul}")
        "ru" -> Regex("\\p{IsCyrillic}")
        "ar" -> Regex("\\p{IsArabic}")
        "th" -> Regex("\\p{IsThai}")
        else -> Regex("[a-zA-Z]")
    }

    private fun targetScriptRatio(text: String, targetLang: String): Double {
        val sample = sampleText(text)
        var letters = 0
        var matched = 0
        val scriptRegex = targetScriptRegex(targetLang)
        for (ch in sample) {
            if (ch.isLetterOrDigit()) {
                letters++
                if (scriptRegex.containsMatchIn(ch.toString())) matched++
            }
        }
        return if (letters == 0) 0.0 else matched.toDouble() / letters
    }

    private fun hasEntityDrift(source: String, translation: String): Boolean {
        if (translation.contains(Regex("https?://|www\\.|\\.[a-z]{2,4}(/|$)"))) return true
        if (translation.contains(Regex("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+"))) return true
        if (translation.contains(Regex("[a-z0-9_-]+/[a-z0-9_-]+"))) return true
        val sourceTokens = Regex("[A-Za-z]+").findAll(source).map { it.value.lowercase() }.toSet()
        val camelInTranslation = Regex("[a-z]+[A-Z][A-Za-z]+").findAll(translation)
            .any { it.value.lowercase() !in sourceTokens }
        return camelInTranslation
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.CacheValidatorTest"`
Expected: PASS（9 tests）。若 `length_ratio` 用例的阈值边界不符，对照 `background.js:843-850` 调整测试数据而非放宽规则。

- [ ] **Step 5: 比对专有名词白名单**

打开 `extension/background.js:801-806`，把 `PROPER_NOUN_WHITELIST` 补全为与扩展完全一致的 30 项，删除 `TODO-COPY` 注释。

- [ ] **Step 6: Commit**

```bash
git add android/
git commit -m "feat(android): port cache validator with all bad-hit heuristics"
```

### Task 7: 内存 LRU + Room 持久化缓存

**Files:**
- Create: `core/MemoryLruCache.kt`
- Create: `data/CacheEntity.kt`, `data/CacheDao.kt`, `data/AppDatabase.kt`
- Create: `core/TranslationCache.kt`
- Test: `core/MemoryLruCacheTest.kt`, `core/TranslationCacheTest.kt`

分层对应扩展：内存 Map（插入序即 LRU）+ 持久化；容量按字节（`key.length*2 + value.length*2`，UTF-16 估算）。读热路径只查版本+非空，完整校验只在写入时。

- [ ] **Step 1: 写失败测试**

`core/MemoryLruCacheTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MemoryLruCacheTest {
    @Test
    fun `hit moves entry to most recent`() {
        val c = MemoryLruCache(maxBytes = 1000)
        c.put("a", "1"); c.put("b", "2"); c.put("c", "3")
        c.get("a")
        c.put("d", "4")
        // 容量足够时不淘汰；这里验证顺序：直接触发淘汰见下个用例
        assertEquals("1", c.get("a"))
    }

    @Test
    fun `evicts oldest when over byte budget`() {
        // 每条 key(1*2)+value(10*2)=22 字节，预算 50 -> 最多 2 条
        val c = MemoryLruCache(maxBytes = 50)
        c.put("a", "1234567890")
        c.put("b", "1234567890")
        c.get("a") // a 变最新，b 最旧
        c.put("c", "1234567890") // 淘汰 b
        assertNull(c.get("b"))
        assertEquals("1234567890", c.get("a"))
        assertEquals("1234567890", c.get("c"))
    }

    @Test
    fun `oversized single entry evicts everything including itself`() {
        val c = MemoryLruCache(maxBytes = 10)
        c.put("key", "a value far too large for the budget")
        assertNull(c.get("key"))
    }
}
```

`core/TranslationCacheTest.kt`（用内存 fake DAO，不启 Room）:

```kotlin
package com.yuxtrans.app.core

import com.yuxtrans.app.data.CacheEntity
import com.yuxtrans.app.data.CacheStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TranslationCacheTest {
    class FakeStore : CacheStore {
        val data = mutableMapOf<String, CacheEntity>()
        override suspend fun get(key: String) = data[key]
        override suspend fun put(entity: CacheEntity) { data[entity.key] = entity }
        override suspend fun getAll() = data.values.toList()
        override suspend fun delete(keys: List<String>) { keys.forEach { data.remove(it) } }
        override suspend fun clear() = data.clear()
    }

    private fun makeCache(maxBytes: Long = 50L * 1024 * 1024) =
        TranslationCache(MemoryLruCache(maxBytes), FakeStore())

    @Test
    fun `write then hit returns cached result`() = runTest {
        val cache = makeCache()
        cache.set("hello world this is long", "en", "zh", "normal", "gpt-4o", "你好世界这是一个很长的句子")
        val hit = cache.get("hello world this is long", "en", "zh", "normal", "gpt-4o")
        assertEquals("你好世界这是一个很长的句子", hit)
    }

    @Test
    fun `short source is rejected on write`() = runTest {
        val cache = makeCache()
        cache.set("short", "en", "zh", "normal", "gpt-4o", "短")
        assertNull(cache.get("short", "en", "zh", "normal", "gpt-4o"))
    }

    @Test
    fun `refusal translation is rejected on write`() = runTest {
        val cache = makeCache()
        cache.set("translate this sentence please", "en", "zh", "normal", "gpt-4o", "I'm sorry, I cannot translate.")
        assertNull(cache.get("translate this sentence please", "en", "zh", "normal", "gpt-4o"))
    }

    @Test
    fun `different model does not hit`() = runTest {
        val cache = makeCache()
        cache.set("hello world this is long", "en", "zh", "normal", "gpt-4o", "你好世界这是一个很长的句子")
        assertNull(cache.get("hello world this is long", "en", "zh", "normal", "qwen-turbo"))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.MemoryLruCacheTest" --tests "com.yuxtrans.app.core.TranslationCacheTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/MemoryLruCache.kt`:

```kotlin
package com.yuxtrans.app.core

class MemoryLruCache(private val maxBytes: Long) {
    private val map = object : LinkedHashMap<String, String>(256, 0.75f, true) {}
    private var currentBytes = 0L

    @Synchronized
    fun get(key: String): String? = map[key]

    @Synchronized
    fun put(key: String, value: String) {
        map.remove(key)?.let { currentBytes -= entryBytes(key, it) }
        map[key] = value
        currentBytes += entryBytes(key, value)
        evictIfNeeded()
    }

    @Synchronized
    fun remove(key: String) {
        map.remove(key)?.let { currentBytes -= entryBytes(key, it) }
    }

    @Synchronized
    fun clear() {
        map.clear()
        currentBytes = 0L
    }

    @Synchronized
    fun size(): Int = map.size

    private fun entryBytes(key: String, value: String) = (key.length + value.length) * 2L

    private fun evictIfNeeded() {
        val it = map.entries.iterator()
        while (currentBytes > maxBytes && it.hasNext()) {
            val oldest = it.next()
            currentBytes -= entryBytes(oldest.key, oldest.value)
            it.remove()
        }
    }
}
```

`data/CacheEntity.kt` + `CacheStore` 接口（接口隔离 Room，方便单测 fake）:

```kotlin
package com.yuxtrans.app.data

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase

@Entity(tableName = "translations")
data class CacheEntity(
    @PrimaryKey val key: String,
    val value: String,
    val timestamp: Long
)

/** 隔离 Room 的存储接口，单测用 fake 实现 */
interface CacheStore {
    suspend fun get(key: String): CacheEntity?
    suspend fun put(entity: CacheEntity)
    suspend fun getAll(): List<CacheEntity>
    suspend fun delete(keys: List<String>)
    suspend fun clear()
}

@Dao
interface CacheDao {
    @Query("SELECT * FROM translations WHERE `key` = :key")
    suspend fun get(key: String): CacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(entity: CacheEntity)

    @Query("SELECT * FROM translations ORDER BY timestamp DESC")
    suspend fun getAll(): List<CacheEntity>

    @Query("DELETE FROM translations WHERE `key` IN (:keys)")
    suspend fun delete(keys: List<String>)

    @Query("DELETE FROM translations")
    suspend fun clear()
}

@Database(entities = [CacheEntity::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun cacheDao(): CacheDao
}

class RoomCacheStore(private val dao: CacheDao) : CacheStore {
    override suspend fun get(key: String) = dao.get(key)
    override suspend fun put(entity: CacheEntity) = dao.put(entity)
    override suspend fun getAll() = dao.getAll()
    override suspend fun delete(keys: List<String>) = dao.delete(keys)
    override suspend fun clear() = dao.clear()
}
```

`core/TranslationCache.kt`:

```kotlin
package com.yuxtrans.app.core

import com.yuxtrans.app.data.CacheEntity
import com.yuxtrans.app.data.CacheStore

class TranslationCache(
    private val memory: MemoryLruCache,
    private val store: CacheStore
) {
    /** 读热路径：只查版本 + 非空（对应 background.js:700-720） */
    suspend fun get(
        text: String, sourceLang: String, targetLang: String, style: String, model: String
    ): String? {
        val key = CacheKeys.generateKey(text, sourceLang, targetLang, style, model)
        memory.get(key)?.let { return it }
        val entity = store.get(key) ?: return null
        if (CacheKeys.parseKey(entity.key) == null || entity.value.isEmpty()) {
            store.delete(listOf(key))
            return null
        }
        memory.put(key, entity.value)
        return entity.value
    }

    /** 写入：先过完整校验器，无效直接丢弃（对应 setToCache） */
    suspend fun set(
        text: String, sourceLang: String, targetLang: String, style: String,
        model: String, translation: String
    ) {
        val key = CacheKeys.generateKey(text, sourceLang, targetLang, style, model)
        if (!CacheValidator.validate(key, translation).valid) return
        memory.put(key, translation)
        store.put(CacheEntity(key, translation, System.currentTimeMillis()))
    }

    suspend fun loadAllIntoMemory() {
        for (entity in store.getAll()) {
            if (CacheValidator.validate(entity.key, entity.value).valid) {
                memory.put(entity.key, entity.value)
            }
        }
    }

    suspend fun clear() {
        memory.clear()
        store.clear()
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.MemoryLruCacheTest" --tests "com.yuxtrans.app.core.TranslationCacheTest"`
Expected: PASS（3 + 4 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): add layered translation cache with lru and room"
```

### Task 8: Prompt 构建（PromptBuilder）

**Files:**
- Create: `core/PromptBuilder.kt`
- Test: `core/PromptBuilderTest.kt`

移植源：`extension/lib/sw/translate-core.js:18-52`。Prompt 放在 user 消息，无 system 消息。

- [ ] **Step 1: 写失败测试**

`core/PromptBuilderTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PromptBuilderTest {
    @Test
    fun `prompt contains target language rules and text`() {
        val p = PromptBuilder.build("hello", "auto", "zh", "normal")
        assertTrue(p.contains("Simplified Chinese"))
        assertTrue(p.contains("STRICT OUTPUT RULES"))
        assertTrue(p.contains("Text to translate:\nhello"))
        assertFalse(p.contains("from")) // auto 源语不写 from
    }

    @Test
    fun `explicit source language appears in prompt`() {
        val p = PromptBuilder.build("hello", "en", "zh", "normal")
        assertTrue(p.contains("from English to Simplified Chinese"))
    }

    @Test
    fun `style hint appended for non-normal style`() {
        val p = PromptBuilder.build("hello", "en", "zh", "academic")
        assertTrue(p.contains("academic and formal"))
    }

    @Test
    fun `context block included when provided`() {
        val p = PromptBuilder.build("hello", "en", "zh", "normal", title = "Test Page", url = "https://example.com")
        assertTrue(p.contains("Page context"))
        assertTrue(p.contains("Test Page"))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.PromptBuilderTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/PromptBuilder.kt`（骨架文本与 `translate-core.js:18-52` 逐字一致）:

```kotlin
package com.yuxtrans.app.core

object PromptBuilder {
    fun build(
        text: String,
        sourceLang: String,
        targetLang: String,
        style: String,
        title: String? = null,
        url: String? = null
    ): String {
        val targetName = Constants.LANG_NAMES[targetLang] ?: targetLang
        val sourcePart = if (sourceLang == "auto") "" else " from ${Constants.LANG_NAMES[sourceLang] ?: sourceLang}"
        val styleHint = Constants.STYLE_PROMPTS[style] ?: ""

        val sb = StringBuilder()
        sb.append("You are a professional translator. Translate the following text")
            .append(sourcePart).append(" to ").append(targetName).append(".")
        if (styleHint.isNotEmpty()) sb.append(" ").append(styleHint)
        sb.append("\n\nSTRICT OUTPUT RULES:\n")
        sb.append("- Provide ONLY the translation of the text below. No explanations, notes, markdown, or code fences.\n")
        sb.append("- Translate naturally, not word-by-word.\n")
        sb.append("- Preserve proper nouns, brand names, URLs, and code unchanged.\n")
        sb.append("- Keep numbers, punctuation marks, and formatting intact.\n")
        sb.append("- If the text is already in the target language or contains only proper nouns/code/numbers, return it unchanged.")
        if (!title.isNullOrEmpty() || !url.isNullOrEmpty()) {
            sb.append("\n\nPage context (for disambiguation only, do not translate):")
            if (!title.isNullOrEmpty()) sb.append("\nTitle: ").append(title.take(200))
            if (!url.isNullOrEmpty()) sb.append("\nURL: ").append(url.take(200))
        }
        sb.append("\n\nText to translate:\n").append(text)
        return sb.toString()
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.PromptBuilderTest"`
Expected: PASS（4 tests）。注意第 1 个用例 `assertFalse(p.contains("from"))` 不成立——规则文本里含 "formatting" 等词。把该断言改为 `assertFalse(p.contains("from English"))`。

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): port translation prompt builder"
```

### Task 9: 供应商适配层（ProviderAdapter）

**Files:**
- Create: `core/ProviderAdapter.kt`
- Test: `core/ProviderAdapterTest.kt`

移植源：`extension/background.js:1364-1477`（`getEndpoint`/`getModel`/`getFormat`/`buildRequest`/`parseResponse`）。用 OkHttp + kotlinx-serialization。

- [ ] **Step 1: 写失败测试**

`core/ProviderAdapterTest.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderAdapterTest {
    private fun profile(provider: String, endpoint: String, key: String = "k", model: String = "m") =
        ProviderProfile(id = "$provider:$model", provider = provider, apiKey = key, endpoint = endpoint, model = model)

    @Test
    fun `openai format request has bearer auth and temperature`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"你好"}}]}"""))
        server.start()
        val adapter = ProviderAdapter(profile("qwen", server.url("/v1/chat/completions").toString()))
        val result = adapter.translate("prompt")
        val req = server.takeRequest()
        assertEquals("Bearer k", req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().contains("\"temperature\":0.3"))
        assertEquals("你好", result)
        server.shutdown()
    }

    @Test
    fun `anthropic format request has x-api-key and max_tokens`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"content":[{"text":"你好"}]}"""))
        server.start()
        val adapter = ProviderAdapter(profile("anthropic", server.url("/v1/messages").toString()))
        val result = adapter.translate("prompt")
        val req = server.takeRequest()
        assertEquals("k", req.getHeader("x-api-key"))
        assertEquals("2023-06-01", req.getHeader("anthropic-version"))
        assertTrue(req.body.readUtf8().contains("\"max_tokens\":4096"))
        assertEquals("你好", result)
        server.shutdown()
    }

    @Test
    fun `endpoint auto appends chat completions suffix`() {
        val adapter = ProviderAdapter(profile("openai", "https://proxy.example.com/v1"))
        assertEquals("https://proxy.example.com/v1/chat/completions", adapter.resolvedEndpoint())
    }

    @Test
    fun `endpoint not appended when already suffixed or anthropic`() {
        assertEquals(
            "https://api.anthropic.com/v1/messages",
            ProviderAdapter(profile("anthropic", "https://api.anthropic.com/v1/messages")).resolvedEndpoint()
        )
        assertEquals(
            "https://x.com/v1/chat/completions",
            ProviderAdapter(profile("openai", "https://x.com/v1/chat/completions")).resolvedEndpoint()
        )
    }

    @Test
    fun `http 429 throws TranslationError with rate limit flag`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(429))
        server.start()
        val adapter = ProviderAdapter(profile("openai", server.url("/v1/chat/completions").toString()))
        try {
            adapter.translate("prompt")
            error("should throw")
        } catch (e: TranslationError) {
            assertTrue(e.isRateLimit)
            assertEquals("openai", e.engine)
        }
        server.shutdown()
    }

    @Test
    fun `model falls back to provider default then gpt-3-5-turbo`() {
        val noModel = ProviderProfile(id = "qwen:", provider = "qwen", endpoint = "https://x/v1/chat/completions")
        assertEquals("qwen-turbo", ProviderAdapter(noModel).resolvedModel())
        val unknown = ProviderProfile(id = "x:", provider = "unknownvendor", endpoint = "https://x/v1/chat/completions")
        assertEquals("gpt-3.5-turbo", ProviderAdapter(unknown).resolvedModel())
    }
}
```

`TranslationError` 需要加 `isRateLimit` 字段——在 `core/Models.kt` 中把它改为：

```kotlin
class TranslationError(
    message: String,
    val engine: String,
    val isRateLimit: Boolean = false,
    cause: Throwable? = null
) : Exception(message, cause)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.ProviderAdapterTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/ProviderAdapter.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ProviderAdapter(
    val profile: ProviderProfile,
    private val client: OkHttpClient = defaultClient()
) {
    private val json = Json { ignoreUnknownKeys = true }

    val format: ProviderFormat
        get() = when {
            profile.provider == "anthropic" -> ProviderFormat.ANTHROPIC
            profile.provider == "custom" -> profile.format ?: ProviderFormat.OPENAI
            else -> ProviderFormat.OPENAI
        }

    fun resolvedEndpoint(): String {
        var ep = profile.endpoint.ifEmpty { Constants.API_ENDPOINTS[profile.provider] ?: "" }
        if (profile.provider != "anthropic" &&
            !ep.endsWith("/chat/completions") && !ep.endsWith("/v1/messages")
        ) {
            ep = ep.trimEnd('/') + "/chat/completions"
        }
        return ep
    }

    fun resolvedModel(): String =
        profile.model.ifEmpty { Constants.DEFAULT_MODELS[profile.provider]?.first() ?: "gpt-3.5-turbo" }

    fun buildRequestBody(prompt: String, stream: Boolean, jsonMode: Boolean = false): String {
        val messages = putJsonArray {
            addJsonObject {
                put("role", "user")
                put("content", prompt)
            }
        }
        return buildJsonObject {
            put("model", resolvedModel())
            put("stream", stream)
            if (format == ProviderFormat.ANTHROPIC) {
                put("max_tokens", 4096)
            } else {
                put("temperature", 0.3)
                if (jsonMode && !stream && profile.provider in Constants.JSON_MODE_PROVIDERS) {
                    putJsonObject("response_format") { put("type", "json_object") }
                }
            }
            put("messages", messages)
        }.toString()
    }

    fun buildHttpRequest(prompt: String, stream: Boolean, jsonMode: Boolean = false): Request {
        val builder = Request.Builder()
            .url(resolvedEndpoint())
            .header("Content-Type", "application/json")
            .post(buildRequestBody(prompt, stream, jsonMode).toRequestBody("application/json".toMediaType()))
        if (format == ProviderFormat.ANTHROPIC) {
            builder.header("x-api-key", profile.apiKey)
            builder.header("anthropic-version", "2023-06-01")
        } else {
            builder.header("Authorization", "Bearer ${profile.apiKey}")
        }
        return builder.build()
    }

    /** 非流式翻译；429 抛 isRateLimit=true 的 TranslationError */
    suspend fun translate(prompt: String, jsonMode: Boolean = false): String = withContext(Dispatchers.IO) {
        client.newCall(buildHttpRequest(prompt, stream = false, jsonMode = jsonMode)).execute().use { resp ->
            if (resp.code == 429) throw TranslationError("rate limited", profile.provider, isRateLimit = true)
            if (!resp.isSuccessful) throw TranslationError("HTTP ${resp.code}", profile.provider)
            parseResponse(resp.body.string())
        }
    }

    fun parseResponse(body: String): String {
        val data = json.parseToJsonElement(body).jsonObject
        return if (format == ProviderFormat.ANTHROPIC) {
            data["content"]?.jsonArray?.firstOrNull()?.jsonObject?.get("text")?.jsonPrimitive?.content ?: ""
        } else {
            // 兼容 qwen 原生格式（background.js:1464-1477）
            data["output"]?.jsonObject?.get("text")?.jsonPrimitive?.content
                ?: data["output"]?.jsonObject?.get("choices")?.jsonArray?.firstOrNull()
                    ?.jsonObject?.get("message")?.jsonObject?.get("content")?.jsonPrimitive?.content
                ?: data["choices"]?.jsonArray?.firstOrNull()?.jsonObject?.get("message")
                    ?.jsonObject?.get("content")?.jsonPrimitive?.content
                ?: ""
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(Constants.CLOUD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(Constants.CLOUD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(Constants.CLOUD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
    }
}
```

注意：`putJsonArray` 在 `buildJsonObject` 内的用法如上（kotlinx-serialization 1.7.x 支持 `put("messages", JsonArray)`，`putJsonArray` 返回的 JsonArray 需 `put("messages", messages)`；若编译报错，改为 `put("messages", buildJsonArray { addJsonObject { ... } })`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.ProviderAdapterTest"`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): port provider adapter with openai and anthropic formats"
```

### Task 10: SSE 流式解析

**Files:**
- Create: `core/SseParser.kt`
- Modify: `core/ProviderAdapter.kt`（加 `translateStream`）
- Test: `core/SseParserTest.kt`

移植源：`extension/background.js:1783-1836`。按 `\n` 切行 + 跨 chunk 缓冲；只处理 `data: ` 前缀；`[DONE]` 结束；三种供应商各自的增量字段。

- [ ] **Step 1: 写失败测试**

`core/SseParserTest.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test

class SseParserTest {
    @Test
    fun `parses openai delta lines across chunk boundaries`() = runTest {
        val body = "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n" +
            "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n" +
            "data: [DONE]\n\n"
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(body).setHeader("Content-Type", "text/event-stream"))
        server.start()
        val adapter = ProviderAdapter(
            ProviderProfile("qwen:m", "qwen", "k", server.url("/v1/chat/completions").toString(), "m")
        )
        val chunks = mutableListOf<String>()
        val full = adapter.translateStream("prompt") { chunks.add(it) }
        assertEquals(listOf("你", "好"), chunks)
        assertEquals("你好", full)
        server.shutdown()
    }

    @Test
    fun `parses anthropic delta text`() = runTest {
        val body = "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"你\"}}\n\n" +
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"好\"}}\n\n"
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(body))
        server.start()
        val adapter = ProviderAdapter(
            ProviderProfile("a:m", "anthropic", "k", server.url("/v1/messages").toString(), "m")
        )
        val full = adapter.translateStream("prompt") {}
        assertEquals("你好", full)
        server.shutdown()
    }

    @Test
    fun `ignores malformed lines and non-data lines`() = runTest {
        val body = ": comment\n\ndata: {bad json\n\ndata: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n"
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(body))
        server.start()
        val adapter = ProviderAdapter(
            ProviderProfile("o:m", "openai", "k", server.url("/v1/chat/completions").toString(), "m")
        )
        assertEquals("", adapter.translateStream("prompt") {})
        server.shutdown()
    }

    @Test
    fun `stream 429 throws rate limit error`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(429))
        server.start()
        val adapter = ProviderAdapter(
            ProviderProfile("o:m", "openai", "k", server.url("/v1/chat/completions").toString(), "m")
        )
        try {
            adapter.translateStream("prompt") {}
            error("should throw")
        } catch (e: TranslationError) {
            assert(e.isRateLimit)
        }
        server.shutdown()
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.SseParserTest"`
Expected: FAIL（编译错误，`translateStream` 未定义）

- [ ] **Step 3: 写实现**

`core/SseParser.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object SseParser {
    private val json = Json { ignoreUnknownKeys = true }

    /** 从一行 data: 载荷中提取增量文本；无法解析或非增量帧返回 "" */
    fun extractChunk(dataLine: String, format: ProviderFormat): String {
        return try {
            val parsed = json.parseToJsonElement(dataLine).jsonObject
            when (format) {
                ProviderFormat.ANTHROPIC ->
                    parsed["delta"]?.jsonObject?.get("text")?.jsonPrimitive?.content ?: ""
                ProviderFormat.OPENAI ->
                    parsed["choices"]?.jsonArray?.firstOrNull()?.jsonObject
                        ?.get("delta")?.jsonObject?.get("content")?.jsonPrimitive?.content ?: ""
            }
        } catch (e: Exception) {
            ""
        }
    }
}
```

`core/ProviderAdapter.kt` 追加（流式超时 60s，对应 `REQUEST_TIMEOUT_MS * 2`）:

```kotlin
    /** SSE 流式翻译；onChunk 逐个增量回调，返回完整译文（trim 后） */
    suspend fun translateStream(prompt: String, onChunk: (String) -> Unit): String =
        withContext(Dispatchers.IO) {
            val streamClient = client.newBuilder()
                .readTimeout(Constants.STREAM_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
            streamClient.newCall(buildHttpRequest(prompt, stream = true)).execute().use { resp ->
                if (resp.code == 429) throw TranslationError("rate limited", profile.provider, isRateLimit = true)
                if (!resp.isSuccessful) throw TranslationError("HTTP ${resp.code}", profile.provider)
                val source = resp.body.source()
                val fullText = StringBuilder()
                var buffer = ""
                while (!source.exhausted()) {
                    buffer += source.readUtf8()
                    val lines = buffer.split("\n")
                    buffer = lines.last()
                    for (line in lines.dropLast(1)) {
                        if (!line.startsWith("data: ")) continue
                        val data = line.removePrefix("data: ").trim()
                        if (data == "[DONE]") continue
                        val chunk = SseParser.extractChunk(data, format)
                        if (chunk.isNotEmpty()) {
                            fullText.append(chunk)
                            onChunk(chunk)
                        }
                    }
                }
                fullText.toString().trim()
            }
        }
```

注意 `readUtf8()` 可能阻塞到连接关闭才返回——OkHttp 的 `BufferedSource.readUtf8()` 读当前全部缓冲即返回，配合 `readTimeout` 可用；若实测流式不分片到达，改用 `source.inputStream().bufferedReader().readLine()` 逐行读取的变体（同样保留跨 chunk buffer 逻辑可省，readLine 自带按行语义）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.SseParserTest"`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): add sse streaming parser and stream translation"
```

### Task 11: 自适应限速器（RateLimiter）

**Files:**
- Create: `core/RateLimiter.kt`
- Test: `core/RateLimiterTest.kt`

移植源：`extension/background.js:101-284`，数值一一对应。

- [ ] **Step 1: 写失败测试**

`core/RateLimiterTest.kt`:

```kotlin
package com.yuxtrans.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RateLimiterTest {
    @Test
    fun `starts at max concurrency with no delay`() {
        val r = RateLimiter()
        assertEquals(10, r.concurrentLimit)
        assertEquals(0, r.requestDelay)
        assertFalse(r.isRateLimited)
    }

    @Test
    fun `two consecutive errors trigger limiting`() {
        val r = RateLimiter()
        r.onResult(success = false, isRateLimitError = false)
        assertFalse(r.isRateLimited)
        r.onResult(success = false, isRateLimitError = false)
        assertTrue(r.isRateLimited)
        assertEquals(7, r.concurrentLimit)  // 10 - 3
        assertEquals(500, r.requestDelay)
    }

    @Test
    fun `429 immediately triggers limiting`() {
        val r = RateLimiter()
        r.onResult(success = false, isRateLimitError = true)
        assertTrue(r.isRateLimited)
        assertEquals(7, r.concurrentLimit)
    }

    @Test
    fun `limits clamp at floor and ceiling`() {
        val r = RateLimiter()
        repeat(10) { r.onResult(success = false, isRateLimitError = true) }
        assertEquals(1, r.concurrentLimit)
        assertEquals(2000, r.requestDelay)
    }

    @Test
    fun `recovery requires cooldown and 5 consecutive successes`() {
        var now = 0L
        val r = RateLimiter(clock = { now })
        r.onResult(false, true) // t=0 限速
        now = 31_000 // 过 30s 冷却
        repeat(4) { r.onResult(true, false) }
        assertEquals(7, r.concurrentLimit) // 4 次还不够
        r.onResult(true, false) // 第 5 次成功触发恢复
        assertEquals(9, r.concurrentLimit)  // 7 + 2
        assertEquals(300, r.requestDelay)   // 500 - 200
    }

    @Test
    fun `fully recovered clears limited flag`() {
        var now = 0L
        val r = RateLimiter(clock = { now })
        r.onResult(false, true)
        now = 31_000
        // 持续成功直到并发回 10 且延迟回 0
        repeat(30) {
            now += 31_000
            repeat(5) { r.onResult(true, false) }
        }
        assertEquals(10, r.concurrentLimit)
        assertEquals(0, r.requestDelay)
        assertFalse(r.isRateLimited)
    }

    @Test
    fun `success resets error streak and vice versa`() {
        val r = RateLimiter()
        r.onResult(false, false)
        r.onResult(true, false) // 重置错误计数
        r.onResult(false, false)
        assertFalse(r.isRateLimited) // 未连续 2 次错误
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.RateLimiterTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/RateLimiter.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.coroutines.delay

class RateLimiter(private val clock: () -> Long = { System.currentTimeMillis() }) {
    companion object {
        const val MIN_CONCURRENT = 1
        const val MAX_CONCURRENT = 10
        const val MIN_DELAY = 0
        const val MAX_DELAY = 2000
        const val SUCCESS_TO_RECOVER = 5
        const val ERROR_TO_LIMIT = 2
        const val RECOVERY_STEP = 2
        const val LIMIT_STEP = 3
        const val RATE_LIMIT_COOLDOWN_MS = 30_000L
    }

    var concurrentLimit = MAX_CONCURRENT
        private set
    var requestDelay = MIN_DELAY
        private set
    var consecutiveSuccess = 0
        private set
    var consecutiveErrors = 0
        private set
    var lastRateLimitTime = 0L
        private set
    var isRateLimited = false
        private set

    @Synchronized
    fun onResult(success: Boolean, isRateLimitError: Boolean) {
        if (success) {
            consecutiveSuccess++
            consecutiveErrors = 0
            tryRecover(requireConsecutiveSuccess = true)
        } else {
            consecutiveErrors++
            consecutiveSuccess = 0
            if (isRateLimitError || consecutiveErrors >= ERROR_TO_LIMIT) {
                isRateLimited = true
                lastRateLimitTime = clock()
                concurrentLimit = (concurrentLimit - LIMIT_STEP).coerceAtLeast(MIN_CONCURRENT)
                requestDelay = (requestDelay + 500).coerceAtMost(MAX_DELAY)
            }
        }
    }

    private fun tryRecover(requireConsecutiveSuccess: Boolean) {
        if (!isRateLimited) return
        if (clock() - lastRateLimitTime <= RATE_LIMIT_COOLDOWN_MS) return
        if (requireConsecutiveSuccess && consecutiveSuccess < SUCCESS_TO_RECOVER) return
        concurrentLimit = (concurrentLimit + RECOVERY_STEP).coerceAtMost(MAX_CONCURRENT)
        requestDelay = (requestDelay - 200).coerceAtLeast(MIN_DELAY)
        if (concurrentLimit == MAX_CONCURRENT && requestDelay == MIN_DELAY) {
            isRateLimited = false
        }
    }

    /** 每个请求前调用（对应 applyRateDelay） */
    suspend fun applyDelay() {
        val d = requestDelay
        if (d > 0) delay(d.toLong())
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.RateLimiterTest"`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): port adaptive rate limiter state machine"
```

### Task 12: 翻译引擎门面（TranslationEngine）

**Files:**
- Create: `core/TranslationEngine.kt`
- Test: `core/TranslationEngineTest.kt`

组合缓存 → 供应商；对外暴露 `translate()` 与 `translateStream()`。限速器在每次 API 调用前后上报结果。

- [ ] **Step 1: 写失败测试**

`core/TranslationEngineTest.kt`（用 MockWebServer 做真 HTTP，缓存用 fake store）:

```kotlin
package com.yuxtrans.app.core

import com.yuxtrans.app.data.CacheEntity
import com.yuxtrans.app.data.CacheStore
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranslationEngineTest {
    class FakeStore : CacheStore {
        val data = mutableMapOf<String, CacheEntity>()
        override suspend fun get(key: String) = data[key]
        override suspend fun put(entity: CacheEntity) { data[entity.key] = entity }
        override suspend fun getAll() = data.values.toList()
        override suspend fun delete(keys: List<String>) { keys.forEach { data.remove(it) } }
        override suspend fun clear() = data.clear()
    }

    private fun engine(server: MockWebServer, store: FakeStore): TranslationEngine {
        val profile = ProviderProfile(
            id = "qwen:qwen-turbo", provider = "qwen", apiKey = "k",
            endpoint = server.url("/v1/chat/completions").toString(), model = "qwen-turbo"
        )
        return TranslationEngine(
            profileProvider = { profile },
            cache = TranslationCache(MemoryLruCache(1024 * 1024), store),
            rateLimiter = RateLimiter()
        )
    }

    @Test
    fun `first call hits api and writes cache`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"这是一个足够长的中文译文句子"}}]}"""))
        server.start()
        val store = FakeStore()
        val e = engine(server, store)
        val req = TranslationRequest("this is a long enough english sentence", "en", "zh")
        val r1 = e.translate(req)
        assertEquals("这是一个足够长的中文译文句子", r1.text)
        assertEquals("qwen", r1.engine)
        assertEquals(1, server.requestCount)
        server.shutdown()
    }

    @Test
    fun `second identical call served from cache without api`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"这是一个足够长的中文译文句子"}}]}"""))
        server.start()
        val store = FakeStore()
        val e = engine(server, store)
        val req = TranslationRequest("this is a long enough english sentence", "en", "zh")
        e.translate(req)
        val r2 = e.translate(req)
        assertTrue(r2.cached)
        assertEquals("cache", r2.engine)
        assertEquals(1, server.requestCount) // 没有第二次 API 调用
        server.shutdown()
    }

    @Test
    fun `rate limiter notified on success and failure`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(429))
        server.enqueue(MockResponse().setResponseCode(429))
        server.start()
        val store = FakeStore()
        val limiter = RateLimiter()
        val profile = ProviderProfile(
            "openai:m", "openai", "k", server.url("/v1/chat/completions").toString(), "m"
        )
        val e = TranslationEngine(
            profileProvider = { profile },
            cache = TranslationCache(MemoryLruCache(1024), store),
            rateLimiter = limiter
        )
        val req = TranslationRequest("this is a long enough english sentence", "en", "zh")
        try { e.translate(req) } catch (_: TranslationError) {}
        try { e.translate(req) } catch (_: TranslationError) {}
        assertTrue(limiter.isRateLimited)
        server.shutdown()
    }

    @Test
    fun `stream translates and caches final text`() = runTest {
        val body = "data: {\"choices\":[{\"delta\":{\"content\":\"这是流式\"}}]}\n\n" +
            "data: {\"choices\":[{\"delta\":{\"content\":\"译文结果\"}}]}\n\ndata: [DONE]\n\n"
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(body))
        server.start()
        val store = FakeStore()
        val e = engine(server, store)
        val chunks = mutableListOf<String>()
        val r = e.translateStream(
            TranslationRequest("this is a long enough english sentence", "en", "zh")
        ) { chunks.add(it) }
        assertEquals("这是流式译文结果", r.text)
        assertEquals(listOf("这是流式", "译文结果"), chunks)
        server.shutdown()
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.TranslationEngineTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/TranslationEngine.kt`:

```kotlin
package com.yuxtrans.app.core

class TranslationEngine(
    private val profileProvider: suspend () -> ProviderProfile,
    private val cache: TranslationCache,
    private val rateLimiter: RateLimiter
) {
    suspend fun translate(request: TranslationRequest): TranslationResult {
        val profile = profileProvider()
        val cached = cache.get(request.text, request.sourceLang, request.targetLang, request.style, profile.model)
        if (cached != null) return TranslationResult(cached, "cache", cached = true)

        val adapter = ProviderAdapter(profile)
        rateLimiter.applyDelay()
        return try {
            val prompt = PromptBuilder.build(request.text, request.sourceLang, request.targetLang, request.style)
            val text = adapter.translate(prompt)
            rateLimiter.onResult(success = true, isRateLimitError = false)
            cache.set(request.text, request.sourceLang, request.targetLang, request.style, profile.model, text)
            TranslationResult(text, profile.provider)
        } catch (e: TranslationError) {
            rateLimiter.onResult(success = false, isRateLimitError = e.isRateLimit)
            throw e
        }
    }

    suspend fun translateStream(request: TranslationRequest, onChunk: (String) -> Unit): TranslationResult {
        val profile = profileProvider()
        val cached = cache.get(request.text, request.sourceLang, request.targetLang, request.style, profile.model)
        if (cached != null) return TranslationResult(cached, "cache", cached = true)

        val adapter = ProviderAdapter(profile)
        rateLimiter.applyDelay()
        return try {
            val prompt = PromptBuilder.build(request.text, request.sourceLang, request.targetLang, request.style)
            val text = adapter.translateStream(prompt, onChunk)
            rateLimiter.onResult(success = true, isRateLimitError = false)
            cache.set(request.text, request.sourceLang, request.targetLang, request.style, profile.model, text)
            TranslationResult(text, profile.provider)
        } catch (e: TranslationError) {
            rateLimiter.onResult(success = false, isRateLimitError = e.isRateLimit)
            throw e
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.TranslationEngineTest"`
Expected: PASS（4 tests）

- [ ] **Step 5: Commit**

```bash
git add android/
git commit -m "feat(android): add translation engine facade with cache and rate limiting"
```

### Task 13: 批量翻译（BatchTranslator）

**Files:**
- Create: `core/BatchTranslator.kt`
- Test: `core/BatchTranslatorTest.kt`

移植源：`extension/background.js:2075-2129`（`splitIntoCharBatches`、`buildBatchPrompt`）、`2252-2281`（三级解析降级 + sanity check）、`2401-2445`（`fallbackBatchItems`）。**`buildBatchPrompt` 的 prompt 全文从 `extension/background.js:2103-2129` 原样移植**（含 few-shot 示例）。

- [ ] **Step 1: 写失败测试**

`core/BatchTranslatorTest.kt`:

```kotlin
package com.yuxtrans.app.core

import com.yuxtrans.app.data.CacheEntity
import com.yuxtrans.app.data.CacheStore
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BatchTranslatorTest {
    class FakeStore : CacheStore {
        val data = mutableMapOf<String, CacheEntity>()
        override suspend fun get(key: String) = data[key]
        override suspend fun put(entity: CacheEntity) { data[entity.key] = entity }
        override suspend fun getAll() = data.values.toList()
        override suspend fun delete(keys: List<String>) { keys.forEach { data.remove(it) } }
        override suspend fun clear() = data.clear()
    }

    private fun engine(server: MockWebServer): TranslationEngine {
        val profile = ProviderProfile(
            "openai:m", "openai", "k", server.url("/v1/chat/completions").toString(), "m"
        )
        return TranslationEngine(
            profileProvider = { profile },
            cache = TranslationCache(MemoryLruCache(1024 * 1024), FakeStore()),
            rateLimiter = RateLimiter()
        )
    }

    @Test
    fun `splitIntoCharBatches respects char budget and isolates oversized items`() {
        val items = listOf("a".repeat(100), "b".repeat(100), "c".repeat(5000), "d".repeat(50))
        val batches = BatchTranslator.splitIntoCharBatches(items, 250)
        // [a,b] 一批（200<=250），c 独立成批（超限），d 一批
        assertEquals(3, batches.size)
        assertEquals(listOf(0, 1), batches[0])
        assertEquals(listOf(2), batches[1])
        assertEquals(listOf(3), batches[2])
    }

    @Test
    fun `parseBatchResponse handles plain json code fence and regex fallback`() {
        assertEquals(listOf("甲", "乙"), BatchTranslator.parseBatchResponse("""["甲","乙"]""", 2))
        assertEquals(listOf("甲", "乙"), BatchTranslator.parseBatchResponse("```json\n[\"甲\",\"乙\"]\n```", 2))
        assertEquals(listOf("甲", "乙"), BatchTranslator.parseBatchResponse("结果如下: [\"甲\", \"乙\"] 完毕", 2))
    }

    @Test
    fun `parseBatchResponse rejects length mismatch and single-collapse`() {
        assertEquals(null, BatchTranslator.parseBatchResponse("""["甲"]""", 2))
        // unique>2 但译文只剩 1 种 -> 上下文偏差
        assertEquals(null, BatchTranslator.parseBatchResponse("""["同","同","同"]""", 3))
    }

    @Test
    fun `batch success path returns mapped results`() = runTest {
        val texts = (1..3).map { "sentence number $it is long enough" }
        val translations = (1..3).map { "第 $it 句足够长的译文" }
        val body = kotlinx.serialization.json.JsonArray(
            translations.map { kotlinx.serialization.json.JsonPrimitive(it) }
        ).toString()
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(
            """{"choices":[{"message":{"content":${kotlinx.serialization.json.JsonPrimitive(body)}}]}"""
        ))
        server.start()
        val bt = BatchTranslator(engine(server))
        val results = bt.translateBatch(texts, "en", "zh", "normal")
        assertEquals(3, results.size)
        assertTrue(results.all { it.success })
        assertEquals(translations, results.map { it.text })
        server.shutdown()
    }

    @Test
    fun `batch parse failure falls back to per-item translation`() = runTest {
        val texts = listOf("first long enough sentence", "second long enough sentence")
        val server = MockWebServer()
        // 批量请求返回垃圾
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"not json at all"}}]}"""))
        // 两句各自的单句补全
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"第一句足够长的译文结果"}}]}"""))
        server.enqueue(MockResponse().setBody("""{"choices":[{"message":{"content":"第二句足够长的译文结果"}}]}"""))
        server.start()
        val bt = BatchTranslator(engine(server))
        val results = bt.translateBatch(texts, "en", "zh", "normal")
        assertTrue(results.all { it.success })
        assertEquals("第一句足够长的译文结果", results[0].text)
        assertEquals(3, server.requestCount) // 1 批量 + 2 单句
        server.shutdown()
    }

    @Test
    fun `item failing 3 retries returns failure result`() = runTest {
        val texts = listOf("first long enough sentence")
        val server = MockWebServer()
        repeat(4) { server.enqueue(MockResponse().setResponseCode(500)) } // 1 批量 + 3 重试
        server.start()
        val bt = BatchTranslator(engine(server))
        val results = bt.translateBatch(texts, "en", "zh", "normal")
        assertFalse(results[0].success)
        assertEquals(texts[0], results[0].originalText)
        assertEquals(4, server.requestCount)
        server.shutdown()
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.BatchTranslatorTest"`
Expected: FAIL（编译错误）

- [ ] **Step 3: 写实现**

`core/BatchTranslator.kt`:

```kotlin
package com.yuxtrans.app.core

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

class BatchTranslator(private val engine: TranslationEngine) {

    data class BatchItemResult(
        val text: String = "",
        val success: Boolean,
        val error: String = "",
        val originalText: String = ""
    )

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** 按字符上限切批；返回元素下标分组。超限单条独立成批（background.js:2075-2097） */
        fun splitIntoCharBatches(texts: List<String>, maxChars: Int): List<List<Int>> {
            val batches = mutableListOf<List<Int>>()
            var current = mutableListOf<Int>()
            var currentChars = 0
            texts.forEachIndexed { i, t ->
                if (t.length > maxChars) {
                    if (current.isNotEmpty()) { batches.add(current); current = mutableListOf(); currentChars = 0 }
                    batches.add(listOf(i))
                } else if (currentChars + t.length > maxChars) {
                    batches.add(current)
                    current = mutableListOf(i)
                    currentChars = t.length
                } else {
                    current.add(i)
                    currentChars += t.length
                }
            }
            if (current.isNotEmpty()) batches.add(current)
            return batches
        }

        /** 三级降级：裸 JSON → ```json 块 → 正则抠数组；长度不符或译文坍缩为 null */
        fun parseBatchResponse(content: String, expectedCount: Int): List<String>? {
            val trimmed = content.trim()
            val candidates = mutableListOf(trimmed)
            Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(trimmed)?.let { candidates.add(it.groupValues[1].trim()) }
            Regex("\\[[\\s\\S]*?\\]").find(trimmed)?.let { candidates.add(it.value) }
            for (candidate in candidates) {
                try {
                    val arr = json.parseToJsonElement(candidate).jsonArray
                    val list = arr.map { it.jsonPrimitive.content.trim() }
                    if (list.size != expectedCount) continue
                    if (expectedCount > 2 && list.toSet().size <= 1) continue
                    return list
                } catch (_: Exception) { /* try next candidate */ }
            }
            return null
        }
    }

    /**
     * 批量翻译：缓存由 engine 内部处理（单句补全路径）；
     * 批量请求本身不逐条查缓存（整页场景由调用方预筛，见 PageTranslateActivity 任务）。
     */
    suspend fun translateBatch(
        texts: List<String>, sourceLang: String, targetLang: String, style: String
    ): List<BatchItemResult> {
        val results = arrayOfNulls<BatchItemResult>(texts.size)
        val batches = splitIntoCharBatches(texts, Constants.MAX_BATCH_CHARS)
        val fallbackIndices = mutableListOf<Int>()

        for (batch in batches) {
            val batchTexts = batch.map { texts[it] }
            try {
                val prompt = buildBatchPrompt(batchTexts, sourceLang, targetLang, style)
                // 批量走非流式 jsonMode；经 engine 的 profile 拿 adapter
                val content = engine.translateBatchRaw(prompt)
                val parsed = parseBatchResponse(content, batch.size)
                if (parsed != null) {
                    batch.forEachIndexed { i, originalIndex ->
                        results[originalIndex] = BatchItemResult(parsed[i], success = true)
                    }
                } else {
                    fallbackIndices.addAll(batch)
                }
            } catch (e: Exception) {
                fallbackIndices.addAll(batch)
            }
        }

        if (fallbackIndices.isNotEmpty()) {
            fallbackItems(fallbackIndices, texts, sourceLang, targetLang, style, results)
        }
        return results.mapIndexed { i, r ->
            r ?: BatchItemResult(success = false, error = "unknown", originalText = texts[i])
        }
    }

    /** 单句补全：按限速器当前并发分 chunk，每句最多 3 次重试（background.js:2401-2445） */
    private suspend fun fallbackItems(
        indices: List<Int>, texts: List<String>,
        sourceLang: String, targetLang: String, style: String,
        results: Array<BatchItemResult?>
    ) = coroutineScope {
        val concurrency = engine.rateLimiter.concurrentLimit
        for (chunk in indices.chunked(concurrency)) {
            chunk.map { index ->
                async {
                    var lastError = ""
                    var ok = false
                    for (retry in 0 until 3) {
                        if (retry > 0) delay(retry * 1000L)
                        try {
                            val r = engine.translate(TranslationRequest(texts[index], sourceLang, targetLang, style))
                            results[index] = BatchItemResult(r.text, success = true)
                            ok = true
                            break
                        } catch (e: Exception) {
                            lastError = e.message ?: "unknown"
                        }
                    }
                    if (!ok) {
                        results[index] = BatchItemResult(success = false, error = lastError, originalText = texts[index])
                    }
                }
            }.forEach { it.await() }
        }
    }

    /** buildBatchPrompt：从 extension/background.js:2103-2129 原样移植 prompt 全文（含 STRICT OUTPUT RULES 与 few-shot 示例） */
    private fun buildBatchPrompt(texts: List<String>, sourceLang: String, targetLang: String, style: String): String {
        val targetName = Constants.LANG_NAMES[targetLang] ?: targetLang
        val sourcePart = if (sourceLang == "auto") "" else " from ${Constants.LANG_NAMES[sourceLang] ?: sourceLang}"
        val jsonArray = texts.joinToString(",", "[", "]") { Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(it)) }
        // TODO-COPY: 与 background.js:2103-2129 逐字比对，以下为结构骨架
        return """You are a professional translator. Translate each text in the JSON array$sourcePart to $targetName.
Return ONLY a JSON array of translated strings with EXACTLY the same length as the input array. No explanations, no markdown fences.
Input: $jsonArray"""
    }
}
```

同时 `TranslationEngine` 需要暴露批量原始请求与限速器，在 `core/TranslationEngine.kt` 中追加：

```kotlin
    val rateLimiter: RateLimiter
        get() = field

    /** 批量专用：jsonMode 非流式请求，返回 message.content 原文 */
    suspend fun translateBatchRaw(prompt: String): String {
        val profile = profileProvider()
        val adapter = ProviderAdapter(profile)
        rateLimiter.applyDelay()
        return try {
            val content = adapter.translate(prompt, jsonMode = true)
            rateLimiter.onResult(success = true, isRateLimitError = false)
            content
        } catch (e: TranslationError) {
            rateLimiter.onResult(success = false, isRateLimitError = e.isRateLimit)
            throw e
        }
    }
```

注意 `val rateLimiter get() = field` 写法非法——直接把构造参数 `private val rateLimiter` 改为 `val rateLimiter`（public）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "com.yuxtrans.app.core.BatchTranslatorTest"`
Expected: PASS（6 tests）

- [ ] **Step 5: 比对批量 prompt 全文**

打开 `extension/background.js:2103-2129`，把 `buildBatchPrompt` 替换为逐字一致的完整版（含 few-shot 示例），删除 `TODO-COPY` 注释。

- [ ] **Step 6: 跑全部单测**

Run: `cd android && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS（约 40+ tests）

- [ ] **Step 7: Commit**

```bash
git add android/
git commit -m "feat(android): port batch translation with parse fallback and per-item retry"
```

### Task 14: 配置存储（ConfigStore）

**Files:**
- Create: `data/ConfigStore.kt`
- Modify: `YuxTransApp.kt`（持有全局单例）

DataStore 存 ActiveConfig + 档案列表（JSON）；API key 用 EncryptedSharedPreferences。无单元测试（Android 依赖），真机验证。

- [ ] **Step 1: 写实现**

`data/ConfigStore.kt`:

```kotlin
package com.yuxtrans.app.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.yuxtrans.app.core.ActiveConfig
import com.yuxtrans.app.core.ProviderFormat
import com.yuxtrans.app.core.ProviderProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.dataStore by preferencesDataStore(name = "yuxtrans_config")

class ConfigStore(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }

    private object Keys {
        val ACTIVE_PROFILE_ID = stringPreferencesKey("active_profile_id")
        val SOURCE_LANG = stringPreferencesKey("source_lang")
        val TARGET_LANG = stringPreferencesKey("target_lang")
        val TRANSLATE_STYLE = stringPreferencesKey("translate_style")
        val BILINGUAL_MODE = booleanPreferencesKey("bilingual_mode")
        val APP_BLACKLIST = stringSetPreferencesKey("app_blacklist")
        val MAX_CACHE_MB = intPreferencesKey("max_cache_mb")
        val MAX_CACHE_ENTRIES = intPreferencesKey("max_cache_entries")
        val PROFILES_JSON = stringPreferencesKey("profiles_json")
    }

    private val securePrefs by lazy {
        EncryptedSharedPreferences.create(
            context, "yuxtrans_keys",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    /** 档案的 apiKey 字段序列化时置空，真实 key 存 securePrefs，键为 profile.id */
    private fun profileToJson(p: ProviderProfile) =
        json.encodeToString(ProfileDto.serializer(), ProfileDto(p.id, p.provider, p.endpoint, p.model, p.format?.name))

    private fun profileFromJson(s: String): ProviderProfile {
        val d = json.decodeFromString(ProfileDto.serializer(), s)
        return ProviderProfile(
            id = d.id, provider = d.provider,
            apiKey = securePrefs.getString(d.id, "") ?: "",
            endpoint = d.endpoint, model = d.model,
            format = d.format?.let { runCatching { ProviderFormat.valueOf(it) }.getOrNull() }
        )
    }

    @kotlinx.serialization.Serializable
    private data class ProfileDto(
        val id: String, val provider: String, val endpoint: String, val model: String, val format: String?
    )

    val profilesFlow: Flow<List<ProviderProfile>> = context.dataStore.data.map { prefs ->
        (prefs[Keys.PROFILES_JSON] ?: "")
            .split("\n").filter { it.isNotBlank() }
            .mapNotNull { runCatching { profileFromJson(it) }.getOrNull() }
    }

    val configFlow: Flow<ActiveConfig> = context.dataStore.data.map { prefs ->
        ActiveConfig(
            activeProfileId = prefs[Keys.ACTIVE_PROFILE_ID] ?: "",
            sourceLang = prefs[Keys.SOURCE_LANG] ?: "auto",
            targetLang = prefs[Keys.TARGET_LANG] ?: "zh",
            translateStyle = prefs[Keys.TRANSLATE_STYLE] ?: "normal",
            bilingualMode = prefs[Keys.BILINGUAL_MODE] ?: true,
            appBlacklist = prefs[Keys.APP_BLACKLIST] ?: emptySet(),
            maxCacheMB = prefs[Keys.MAX_CACHE_MB] ?: 50,
            maxCacheEntries = prefs[Keys.MAX_CACHE_ENTRIES] ?: 5000
        )
    }

    suspend fun saveProfiles(profiles: List<ProviderProfile>) {
        for (p in profiles) {
            if (p.apiKey.isNotEmpty()) securePrefs.edit().putString(p.id, p.apiKey).apply()
        }
        context.dataStore.edit { it[Keys.PROFILES_JSON] = profiles.joinToString("\n") { p -> profileToJson(p) } }
    }

    suspend fun saveConfig(config: ActiveConfig) {
        context.dataStore.edit {
            it[Keys.ACTIVE_PROFILE_ID] = config.activeProfileId
            it[Keys.SOURCE_LANG] = config.sourceLang
            it[Keys.TARGET_LANG] = config.targetLang
            it[Keys.TRANSLATE_STYLE] = config.translateStyle
            it[Keys.BILINGUAL_MODE] = config.bilingualMode
            it[Keys.APP_BLACKLIST] = config.appBlacklist
            it[Keys.MAX_CACHE_MB] = config.maxCacheMB
            it[Keys.MAX_CACHE_ENTRIES] = config.maxCacheEntries
        }
    }

    /** 首次启动写入默认档案：qwen + qwen-turbo（无 key，待用户填写） */
    suspend fun ensureDefaultProfile() {
        val profiles = profilesFlow.first()
        if (profiles.isEmpty()) {
            val default = ProviderProfile(id = "qwen:qwen-turbo", provider = "qwen", model = "qwen-turbo")
            saveProfiles(listOf(default))
            saveConfig(configFlow.first().copy(activeProfileId = default.id))
        }
    }

    suspend fun activeProfile(): ProviderProfile? {
        val config = configFlow.first()
        return profilesFlow.first().firstOrNull { it.id == config.activeProfileId }
            ?: profilesFlow.first().firstOrNull()
    }
}
```

`YuxTransApp.kt` 改为持有全局依赖：

```kotlin
package com.yuxtrans.app

import android.app.Application
import androidx.room.Room
import com.yuxtrans.app.core.MemoryLruCache
import com.yuxtrans.app.core.RateLimiter
import com.yuxtrans.app.core.TranslationCache
import com.yuxtrans.app.core.TranslationEngine
import com.yuxtrans.app.data.AppDatabase
import com.yuxtrans.app.data.ConfigStore
import com.yuxtrans.app.data.RoomCacheStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class YuxTransApp : Application() {
    lateinit var configStore: ConfigStore
        private set
    lateinit var engine: TranslationEngine
        private set
    lateinit var cache: TranslationCache
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        configStore = ConfigStore(this)
        val db = Room.databaseBuilder(this, AppDatabase::class.java, "yuxtrans.db").build()
        cache = TranslationCache(MemoryLruCache(maxBytes = 50L * 1024 * 1024), RoomCacheStore(db.cacheDao()))
        engine = TranslationEngine(
            profileProvider = {
                configStore.activeProfile()
                    ?: throw com.yuxtrans.app.core.TranslationError("未配置供应商档案", "config")
            },
            cache = cache,
            rateLimiter = RateLimiter()
        )
        appScope.launch {
            configStore.ensureDefaultProfile()
            cache.loadAllIntoMemory()
        }
    }
}
```

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add config store with datastore and encrypted api keys"
```

### Task 15: 无障碍捕获服务（CaptureService）

**Files:**
- Create: `service/CaptureService.kt`
- Create: `app/src/main/res/xml/accessibility_service_config.xml`
- Modify: `AndroidManifest.xml`（注册 service）

- [ ] **Step 1: 写实现**

`service/CaptureService.kt`:

```kotlin
package com.yuxtrans.app.service

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import com.yuxtrans.app.YuxTransApp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

class CaptureService : AccessibilityService() {

    companion object {
        var instance: CaptureService? = null
            private set
        const val DEBOUNCE_MS = 300L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var pendingText: String? = null
    private var lastEventTime = 0L

    private val debounceRunnable = Runnable {
        val text = pendingText
        if (!text.isNullOrBlank()) {
            OverlayService.show(this, text.trim())
        }
        pendingText = null
    }

    override fun onServiceConnected() {
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED) return
        val packageName = event.packageName?.toString() ?: return
        if (packageName == this.packageName) return
        if (isBlacklisted(packageName)) return

        val text = event.text?.joinToString("") ?: return
        if (text.isBlank() || text.length < 2) return

        pendingText = text
        lastEventTime = System.currentTimeMillis()
        handler.removeCallbacks(debounceRunnable)
        handler.postDelayed(debounceRunnable, DEBOUNCE_MS)
    }

    private fun isBlacklisted(packageName: String): Boolean {
        val app = application as YuxTransApp
        return runBlocking { app.configStore.configFlow.first().appBlacklist.contains(packageName) }
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        instance = null
        handler.removeCallbacks(debounceRunnable)
        super.onDestroy()
    }
}
```

`app/src/main/res/xml/accessibility_service_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeViewTextSelectionChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:canRetrieveWindowContent="true"
    android:notificationTimeout="100"
    android:description="@string/accessibility_desc" />
```

`strings.xml` 追加：

```xml
    <string name="accessibility_desc">监听文本选择以提供划词翻译</string>
```

`AndroidManifest.xml` 的 `<application>` 内追加：

```xml
        <service
            android:name=".service.CaptureService"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
            android:exported="true">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/accessibility_service_config" />
        </service>

        <service
            android:name=".service.OverlayService"
            android:exported="false" />
```

注意：`runBlocking` 读黑名单会阻塞无障碍事件线程，真机若出现卡顿，改为在 `onServiceConnected` 里启动协程收集 `configFlow` 到内存变量。剪贴板兜底（`ClipboardManager` + `OnPrimaryClipChangedListener`）放 v1 后续小迭代，本任务先只实现选择事件；若产品确认需要，在同一 service 内补充。

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add accessibility capture service with debounce and blacklist"
```

### Task 16: 悬浮窗服务（OverlayService）

**Files:**
- Create: `service/OverlayService.kt`
- Create: `app/src/main/res/layout/overlay_translation.xml`

`TYPE_ACCESSIBILITY_OVERLAY` 无需悬浮窗权限。三状态：加载 → 流式 → 完成。

- [ ] **Step 1: 写实现**

`service/OverlayService.kt`:

```kotlin
package com.yuxtrans.app.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.IBinder
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import com.yuxtrans.app.R
import com.yuxtrans.app.YuxTransApp
import com.yuxtrans.app.core.TranslationError
import com.yuxtrans.app.core.TranslationRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class OverlayService : Service() {

    companion object {
        const val EXTRA_TEXT = "extra_text"

        fun show(context: Context, text: String) {
            val intent = Intent(context, OverlayService::class.java).putExtra(EXTRA_TEXT, text)
            context.startService(intent)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var overlayView: View? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT)
        if (!text.isNullOrBlank()) showOverlay(text)
        return START_NOT_STICKY
    }

    private fun windowManager() = getSystemService(WINDOW_SERVICE) as WindowManager

    private fun showOverlay(sourceText: String) {
        removeOverlay()
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = 120 }

        val view = LayoutInflater.from(ContextThemeWrapper(this, R.style.Theme_YuxTrans))
            .inflate(R.layout.overlay_translation, null)
        overlayView = view
        attachDrag(view, params)

        view.findViewById<TextView>(R.id.overlay_source).text = sourceText
        view.findViewById<Button>(R.id.overlay_close).setOnClickListener { removeOverlay() }
        view.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_OUTSIDE) removeOverlay()
            false
        }
        windowManager().addView(view, params)

        runTranslation(sourceText, view)
    }

    private fun runTranslation(sourceText: String, view: View) {
        val app = application as YuxTransApp
        val resultView = view.findViewById<TextView>(R.id.overlay_result)
        val progress = view.findViewById<ProgressBar>(R.id.overlay_progress)
        val actions = view.findViewById<View>(R.id.overlay_actions)
        val retryBtn = view.findViewById<Button>(R.id.overlay_retry)
        val copyBtn = view.findViewById<Button>(R.id.overlay_copy)

        scope.launch {
            val config = app.configStore.configFlow.first()
            val request = TranslationRequest(
                text = sourceText,
                sourceLang = config.sourceLang,
                targetLang = config.targetLang,
                style = config.translateStyle
            )
            try {
                val result = app.engine.translateStream(request) { chunk ->
                    resultView.append(chunk)
                }
                progress.visibility = View.GONE
                actions.visibility = View.VISIBLE
                resultView.text = result.text
                copyBtn.setOnClickListener {
                    val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("translation", result.text))
                    removeOverlay()
                }
            } catch (e: TranslationError) {
                progress.visibility = View.GONE
                actions.visibility = View.VISIBLE
                resultView.text = if (e.isRateLimit) "请求过于频繁，请稍后重试" else "翻译失败：${e.message}"
                retryBtn.visibility = View.VISIBLE
                retryBtn.setOnClickListener {
                    retryBtn.visibility = View.GONE
                    resultView.text = ""
                    progress.visibility = View.VISIBLE
                    runTranslation(sourceText, view)
                }
            }
        }
    }

    private fun attachDrag(view: View, params: WindowManager.LayoutParams) {
        var startX = 0f; var startY = 0f; var startParamX = 0; var startParamY = 0
        view.findViewById<View>(R.id.overlay_drag_handle).setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX; startY = event.rawY
                    startParamX = params.x; startParamY = params.y
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startParamX + (event.rawX - startX).toInt()
                    params.y = startParamY + (event.rawY - startY).toInt()
                    if (overlayView != null) windowManager().updateViewLayout(view, params)
                    true
                }
                else -> false
            }
        }
    }

    private fun removeOverlay() {
        overlayView?.let { runCatching { windowManager().removeView(it) } }
        overlayView = null
    }

    override fun onDestroy() {
        scope.cancel()
        removeOverlay()
        super.onDestroy()
    }
}
```

`app/src/main/res/layout/overlay_translation.xml`（样式用 Task 17 的颜色资源；结构上：顶部拖动条 + 原文 + 进度 + 译文 + 按钮行）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="320dp"
    android:layout_height="wrap_content"
    android:orientation="vertical"
    android:background="@drawable/overlay_bg"
    android:padding="12dp">

    <View
        android:id="@+id/overlay_drag_handle"
        android:layout_width="40dp"
        android:layout_height="4dp"
        android:layout_gravity="center_horizontal"
        android:layout_marginBottom="8dp"
        android:background="@color/yxt_dusk_40" />

    <TextView
        android:id="@+id/overlay_source"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:maxLines="3"
        android:ellipsize="end"
        android:textColor="@color/yxt_text_secondary"
        android:textSize="13sp" />

    <ProgressBar
        android:id="@+id/overlay_progress"
        android:layout_width="24dp"
        android:layout_height="24dp"
        android:layout_gravity="center_horizontal"
        android:layout_marginTop="8dp" />

    <TextView
        android:id="@+id/overlay_result"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:layout_marginTop="8dp"
        android:textColor="@color/yxt_text_primary"
        android:textSize="15sp"
        android:textIsSelectable="true" />

    <LinearLayout
        android:id="@+id/overlay_actions"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="end"
        android:visibility="gone"
        android:layout_marginTop="8dp">

        <Button
            android:id="@+id/overlay_retry"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:visibility="gone"
            android:text="重试" />

        <Button
            android:id="@+id/overlay_copy"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="复制" />

        <Button
            android:id="@+id/overlay_close"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="关闭" />
    </LinearLayout>
</LinearLayout>
```

注意：关闭按钮在 actions（gone）内，加载态无法关闭——把 `overlay_close` 挪到 actions 外面、与拖动条同一行常驻显示。

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add accessibility overlay service with streaming translation"
```

### Task 17: 设计令牌（Compose theme + View 颜色资源）

**Files:**
- Create: `ui/theme/Theme.kt`
- Create: `app/src/main/res/values/colors.xml`
- Create: `app/src/main/res/drawable/overlay_bg.xml`

「书房衬纸」色板从 `extension/design-tokens.css` 的 `--yxt-*` 变量映射。**实现时打开该文件原样抄色值**，下面给出映射结构。

- [ ] **Step 1: 写实现**

`app/src/main/res/values/colors.xml`（色值占位结构——实现时逐一从 `extension/design-tokens.css` 抄入真实十六进制值，禁止自己配色）:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 每个值对应 design-tokens.css 的同名 --yxt-* 变量 -->
    <color name="yxt_paper">#F5F1E8</color>          <!-- --yxt-paper：以文件实际值为准 -->
    <color name="yxt_text_primary">#3A3630</color>   <!-- --yxt-text-primary -->
    <color name="yxt_text_secondary">#6B655B</color> <!-- --yxt-text-secondary -->
    <color name="yxt_text_tertiary">#98917F</color>  <!-- --yxt-text-tertiary -->
    <color name="yxt_dusk">#7A7163</color>           <!-- --yxt-dusk -->
    <color name="yxt_dusk_40">#B8B2A6</color>        <!-- --yxt-dusk-40 -->
    <color name="yxt_warning">#A8584A</color>        <!-- --yxt-warning -->
</resources>
```

`ui/theme/Theme.kt`:

```kotlin
package com.yuxtrans.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val YxtPaper = Color(0xFFF5F1E8)          // 与 colors.xml 同步，以 design-tokens.css 为准
val YxtTextPrimary = Color(0xFF3A3630)
val YxtTextSecondary = Color(0xFF6B655B)
val YxtTextTertiary = Color(0xFF98917F)
val YxtDusk = Color(0xFF7A7163)
val YxtWarning = Color(0xFFA8584A)

private val YxtColorScheme = lightColorScheme(
    primary = YxtDusk,
    onPrimary = YxtPaper,
    background = YxtPaper,
    onBackground = YxtTextPrimary,
    surface = YxtPaper,
    onSurface = YxtTextPrimary,
    onSurfaceVariant = YxtTextSecondary,
    error = YxtWarning
)

@Composable
fun YuxTransTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = YxtColorScheme, content = content)
}
```

`app/src/main/res/drawable/overlay_bg.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android">
    <solid android:color="@color/yxt_paper" />
    <corners android:radius="8dp" />
    <stroke android:width="1dp" android:color="@color/yxt_dusk_40" />
</shape>
```

- [ ] **Step 2: 构建验证 + 视觉核对**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。真机/模拟器跑起来后对照 `logo/使用样例-弹窗板.png` 核对气质：无纯黑纯白、无高饱和色、小圆角。

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add study-paper design tokens for compose and views"
```

### Task 18: 主界面（MainActivity）

**Files:**
- Modify: `ui/MainActivity.kt`

三要素：无障碍服务开启引导、服务运行状态、最近翻译历史（读 Room 缓存表最近 N 条）。

- [ ] **Step 1: 写实现**

`ui/MainActivity.kt`:

```kotlin
package com.yuxtrans.app.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.room.Room
import com.yuxtrans.app.data.AppDatabase
import com.yuxtrans.app.service.CaptureService
import com.yuxtrans.app.ui.theme.YuxTransTheme
import kotlinx.coroutines.flow.flow

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            YuxTransTheme {
                MainScreen(
                    onOpenSettings = { startActivity(Intent(this, SettingsActivity::class.java)) },
                    onOpenPageTranslate = { startActivity(Intent(this, PageTranslateActivity::class.java)) }
                )
            }
        }
    }
}

fun isAccessibilityEnabled(context: Context): Boolean {
    val expected = "${context.packageName}/com.yuxtrans.app.service.CaptureService"
    val enabled = Settings.Secure.getString(
        context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ) ?: return false
    val splitter = TextUtils.SimpleStringSplitter(':')
    splitter.setString(enabled)
    while (splitter.hasNext()) {
        if (splitter.next().equals(expected, ignoreCase = true)) return true
    }
    return false
}

@Composable
fun MainScreen(onOpenSettings: () -> Unit, onOpenPageTranslate: () -> Unit) {
    val context = LocalContext.current
    // 每次回到界面重新检查（简单起见用 produceState 也行，此处用 flow 每 1s 轮询）
    val serviceOn by flow {
        while (true) {
            emit(CaptureService.instance != null || isAccessibilityEnabled(context))
            kotlinx.coroutines.delay(1000)
        }
    }.collectAsState(initial = false)

    Column(Modifier.fillMaxSize().padding(20.dp)) {
        Text("YuxTrans", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text(if (serviceOn) "划词翻译服务运行中" else "划词翻译服务未开启")
                if (!serviceOn) {
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = {
                        context.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    }) { Text("去开启无障碍服务") }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = onOpenPageTranslate) { Text("网页翻译") }
            Button(onClick = onOpenSettings) { Text("设置") }
        }

        Spacer(Modifier.height(24.dp))
        Text("最近翻译", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        RecentTranslations()
    }
}

@Composable
fun RecentTranslations() {
    val context = LocalContext.current
    val items by flow {
        val dao = Room.databaseBuilder(context, AppDatabase::class.java, "yuxtrans.db").build().cacheDao()
        emit(dao.getAll().take(20))
    }.collectAsState(initial = emptyList())

    LazyColumn {
        items(items) { entity ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Text(
                    com.yuxtrans.app.core.CacheKeys.parseKey(entity.key)?.text ?: entity.key,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
                Text(entity.value, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
            }
        }
    }
}
```

注意：`RecentTranslations` 里每次重组新建数据库是反模式——把 DAO 通过 `(context.applicationContext as YuxTransApp)` 暴露（在 YuxTransApp 加 `val cacheDao` 公开属性），实现时改掉。`SettingsActivity`、`PageTranslateActivity` 在后续任务创建，此处 import 会编译失败——先注释掉对应按钮或先建空类；建议顺序：本任务先注释两个按钮的 onClick 中的 Activity 引用，Task 19/20 完成后取消注释。

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add main screen with service status and recent translations"
```

### Task 19: 设置页（SettingsActivity）

**Files:**
- Create: `ui/SettingsActivity.kt`
- Modify: `AndroidManifest.xml`（注册）

四个分组：供应商档案 / 语言与风格 / 触发与黑名单 / 缓存管理。档案编辑：provider 下拉（7 个供应商 + custom）、apiKey、endpoint（默认从 `Constants.API_ENDPOINTS` 预填）、model 下拉（`Constants.DEFAULT_MODELS` 预填，可自由输入）。

- [ ] **Step 1: 写实现**

`ui/SettingsActivity.kt`——用 Compose 实现，结构如下（完整实现约 300 行，按此骨架展开，不得省略功能）：

```kotlin
package com.yuxtrans.app.ui

// 关键组成：
// 1. ProfileSection: profilesFlow.collectAsState 列出档案；
//    每个档案卡片显示 provider/model，点击展开编辑（apiKey PasswordField、endpoint、model），
//    "设为当前" 按钮更新 ActiveConfig.activeProfileId；"新增档案" 按钮弹出供应商选择。
// 2. LangStyleSection: sourceLang(下拉 auto/zh/en/ja/ko/... 来自 Constants.LANG_NAMES 键 + auto)、
//    targetLang(同上无 auto)、translateStyle(普通/学术/技术/文学 四选一分段按钮)。
// 3. BlacklistSection: appBlacklist 包名列表，手动输入添加（如 com.android.bank），点击删除。
// 4. CacheSection: 显示当前缓存条数与字节占用（读 Room）、maxCacheMB 滑杆(10~200)、"清空缓存" 按钮
//    （调 (application as YuxTransApp).cache.clear()）。
// 所有写操作走 ConfigStore.saveProfiles / saveConfig，UI 从 flow 收集，不写本地副本状态。
```

实现要点：
- 用 `rememberCoroutineScope` 发起写操作；读一律 `collectAsState(initial = ...)`。
- apiKey 输入框用 `visualTransformation = PasswordVisualTransformation()`。
- 自定义供应商（custom）额外显示 format 选择（OpenAI / Anthropic）。

`AndroidManifest.xml` 的 `<application>` 内追加：

```xml
        <activity android:name=".ui.SettingsActivity" android:exported="false" />
```

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

- [ ] **Step 3: 真机验证配置链路**

安装到真机/模拟器：新增 deepseek 档案填 key → 设为当前 → 划词翻译验证走了新供应商。取消 MainActivity 中设置按钮的注释。

- [ ] **Step 4: Commit**

```bash
git add android/
git commit -m "feat(android): add settings screen with profiles, languages, blacklist, cache"
```

### Task 20: 内置浏览器整页翻译（PageTranslateActivity）

**Files:**
- Create: `page/PageTranslateActivity.kt`
- Create: `app/src/main/assets/page-translate.js`（Task 21）
- Modify: `AndroidManifest.xml`（注册 + 分享入口 intent-filter）

WebView + JSInterface 桥。Kotlin 侧提供 `translateBatch(textsJson): String`（同步返回 JSON 结果数组）与进度回调。整页 DOM 逻辑全部在注入 JS 里（Task 21），Activity 只负责加载页面、注入脚本、提供翻译桥、显示进度。

- [ ] **Step 1: 写实现**

`page/PageTranslateActivity.kt`:

```kotlin
package com.yuxtrans.app.page

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.yuxtrans.app.YuxTransApp
import com.yuxtrans.app.core.BatchTranslator
import com.yuxtrans.app.ui.theme.YuxTransTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

class PageTranslateActivity : ComponentActivity() {

    private val json = Json { ignoreUnknownKeys = true }
    private var webView: WebView? = null
    private val progress = mutableFloatStateOf(-1f) // <0 表示未在翻译
    private val statusText = mutableStateOf("")

    inner class TranslateBridge {
        /** JS 调：批量翻译。textsJson 为 JSON 数组字符串；返回等长 JSON 数组（失败项为 null） */
        @JavascriptInterface
        fun translateBatch(textsJson: String, sourceLang: String, targetLang: String, style: String): String {
            val texts = json.parseToJsonElement(textsJson).jsonArray.map { it.jsonPrimitive.content }
            val app = application as YuxTransApp
            val results = runBlocking {
                BatchTranslator(app.engine).translateBatch(texts, sourceLang, targetLang, style)
            }
            return jsonArrayOf(results.map { if (it.success) it.text else null })
        }

        @JavascriptInterface
        fun onProgress(completed: Int, total: Int) {
            runOnUiThread {
                progress.floatValue = if (total == 0) 0f else completed.toFloat() / total
                statusText.value = "$completed / $total"
            }
        }

        @JavascriptInterface
        fun onComplete(success: Int, total: Int, failed: Int) {
            runOnUiThread {
                progress.floatValue = 1f
                statusText.value = "完成 $success/$total · 失败 $failed"
            }
        }

        @JavascriptInterface
        fun getConfig(): String {
            val app = application as YuxTransApp
            return runBlocking {
                val config = app.configStore.configFlow.let { flow ->
                    kotlinx.coroutines.flow.first(flow)
                }
                """{"sourceLang":"${config.sourceLang}","targetLang":"${config.targetLang}","style":"${config.translateStyle}","bilingual":${config.bilingualMode}}"""
            }
        }

        private fun jsonArrayOf(items: List<String?>): String =
            items.joinToString(",", "[", "]") {
                if (it == null) "null" else kotlinx.serialization.json.JsonPrimitive(it).toString()
            }
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sharedUrl = intent?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getStringExtra(Intent.EXTRA_TEXT)

        setContent {
            YuxTransTheme {
                PageTranslateScreen(
                    initialUrl = sharedUrl ?: "",
                    progress = progress.floatValue,
                    status = statusText.value,
                    onWebViewCreated = { webView = it },
                    onTranslate = { webView?.evaluateJavascript("window.YuxTransPage.start()", null) },
                    onRestore = { webView?.evaluateJavascript("window.YuxTransPage.restore()", null) }
                )
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    fun configureWebView(wv: WebView) {
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.addJavascriptInterface(TranslateBridge(), "YuxTransBridge")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                val js = assets.open("page-translate.js").bufferedReader().readText()
                view.evaluateJavascript(js, null)
            }
        }
    }
}

@Composable
fun PageTranslateScreen(
    initialUrl: String,
    progress: Float,
    status: String,
    onWebViewCreated: (WebView) -> Unit,
    onTranslate: () -> Unit,
    onRestore: () -> Unit
) {
    val urlState = remember { mutableStateOf(initialUrl) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(8.dp)) {
            OutlinedTextField(
                value = urlState.value,
                onValueChange = { urlState.value = it },
                modifier = Modifier.weight(1f),
                singleLine = true,
                keyboardActions = KeyboardActions(onDone = { /* WebView load */ })
            )
            Button(onClick = onTranslate, Modifier.padding(start = 4.dp)) { Text("翻译") }
            Button(onClick = onRestore, Modifier.padding(start = 4.dp)) { Text("原文") }
        }
        if (progress >= 0f) {
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
            Text(status, Modifier.padding(horizontal = 8.dp))
        }
        AndroidView(
            factory = { ctx ->
                WebView(ctx).also { wv ->
                    (ctx as PageTranslateActivity).configureWebView(wv)
                    onWebViewCreated(wv)
                    if (initialUrl.isNotBlank()) wv.loadUrl(normalizeUrl(initialUrl))
                }
            },
            update = { wv -> /* 地址栏提交时 loadUrl */ },
            modifier = Modifier.fillMaxSize()
        )
    }
}

private fun normalizeUrl(input: String): String =
    if (input.startsWith("http://") || input.startsWith("https://")) input else "https://$input"
```

注意：`getConfig()` 里 `kotlinx.coroutines.flow.first(flow)` 写法非法，应为 `app.configStore.configFlow.first()`（需 import `kotlinx.coroutines.flow.first`）。`@JavascriptInterface` 方法在 JS 线程执行，`runBlocking` 合法但会阻塞 JS 线程——批量翻译期间页面 JS 暂停是可接受的（扩展的 translateBatch 同样是请求-响应模型）；若实测 ANR，改为 `evaluateJavascript` 回调式异步桥。

`AndroidManifest.xml` 的 `<application>` 内追加：

```xml
        <activity
            android:name=".page.PageTranslateActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
        </activity>
```

- [ ] **Step 2: 构建验证**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL（`page-translate.js` 尚未存在时先放一个 `window.YuxTransPage={start(){},restore(){}};` 占位，Task 21 替换）

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): add page translate activity with webview bridge"
```

### Task 21: 整页翻译注入脚本（page-translate.js）

**Files:**
- Create: `app/src/main/assets/page-translate.js`

移植源：`extension/content.js:582-1604`（`collectTextNodes` / `translateBatchParallel` / `applyTranslation` / `restoreOriginalTexts` / `showPageControl`）。这是纯 JS 移植任务，改动点只有三处：
1. `chrome.runtime.sendMessage({action:'translateBatch',...})` → `YuxTransBridge.translateBatch(JSON.stringify(texts), sourceLang, targetLang, style)`（同步返回 JSON 字符串，失败项为 null）。
2. 配置来源 `getConfig` → `JSON.parse(YuxTransBridge.getConfig())`。
3. 进度上报 → `YuxTransBridge.onProgress(completed, total)` / `onComplete(success, total, failed)`。

- [ ] **Step 1: 从 content.js 剥离整页模块**

从 `extension/content.js` 复制以下函数的完整实现到 `page-translate.js`，包在一个全局对象里：

```js
window.YuxTransPage = (function () {
  'use strict';

  // ---- 从 content.js:31-45 复制的默认配置（以 bridge getConfig 覆盖） ----
  const config = { concurrency: 50, batchSize: 20, minTextLength: 2, bilingualMode: true };

  // ---- 从 content.js:587-684 原样复制 collectTextNodes（含 skipSelectors、文本过滤、可视区排序）----
  // ---- 从 content.js:723-831 原样复制 translateBatchParallel，sendMessage 换成桥调用 ----
  // ---- 从 content.js:836-925 原样复制 applyTranslation / markFailedNode（含 originalTexts Map）----
  // ---- 从 content.js:1482-1525 原样复制 restoreOriginalTexts ----
  // ---- 从 content.js:930-1140 原样复制 translatePage 主流程（去重、首屏 mini-batch、随到随渲染）----
  // ---- 从 content.js:1532-1591 原样复制 _startDynamicObserver（MutationObserver 增量翻译）----

  // 桥调用封装（替换 chrome.runtime.sendMessage 的唯一函数）：
  function sendTranslateBatch(texts) {
    const cfg = JSON.parse(YuxTransBridge.getConfig());
    const raw = YuxTransBridge.translateBatch(JSON.stringify(texts), cfg.sourceLang, cfg.targetLang, cfg.style);
    const arr = JSON.parse(raw);
    return arr.map(t => t === null
      ? { success: false, error: 'failed' }
      : { text: t, cached: false, engine: 'cloud', success: true });
  }

  // 控制条改为极简原生 DOM（复用 content.css 的类名与样式内联注入，见下）
  // showPageControl / updatePageControl / showPageControlComplete 从 content.js:1169-1312 复制，
  // 进度回调加 YuxTransBridge.onProgress / onComplete

  return {
    start: translatePage,
    restore: restoreOriginalTexts
  };
})();
```

样式：把 `extension/content.css:399-570` 的整页相关规则（`.yuxtrans-bilingual-text`、`.yuxtrans-failed`、`.yuxtrans-page-control` 系列）与 `content.js:122-140` 的两个关键帧一起，以 `<style>` 标签形式在脚本开头注入（`document.head.appendChild`）。

- [ ] **Step 2: 真机端到端验证**

真机/模拟器打开网页翻译 → 输入一个英文文章页（如 wikipedia 词条）→ 点「翻译」：
- 首屏译文先到，进度条推进；
- 双语译文以左边框斜体小字跟在原文后；
- 点「原文」恢复；
- 滚动页面，动态新增内容被增量翻译。

- [ ] **Step 3: Commit**

```bash
git add android/
git commit -m "feat(android): port full-page translation injection script"
```

### Task 22: 收尾——端到端验证清单与文档

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`

- [ ] **Step 1: 全量单测**

Run: `cd android && ./gradlew :app:testDebugUnitTest`
Expected: 全部 PASS

- [ ] **Step 2: 真机验收清单（逐项打勾）**

- 无障碍引导：首次打开 App → 引导开启无障碍 → 状态变「运行中」。
- 划词翻译：在浏览器/微信读书中选中文本 → 悬浮窗出现 → 流式逐字渲染 → 复制/关闭正常。
- 缓存：同一句子第二次划词 → 瞬时返回（无加载态）。
- 限速：故意填错 key 连续失败 → 悬浮窗错误态 + 重试；日志 `YuxTrans` tag 可查到限速状态变化。
- 供应商切换：设置页新增 deepseek 档案并设为当前 → 划词验证新供应商生效。
- 黑名单：把某 App 包名加入黑名单 → 该 App 内划词不弹窗。
- 网页翻译：App 内输入 URL → 整页双语翻译 → 进度显示 → 恢复原文 → 滚动增量翻译。
- 分享入口：浏览器中分享链接 → 分享列表出现 YuxTrans → 打开内置浏览器。
- 国产 ROM 保活：杀掉 App 后无障碍服务状态在主界面正确显示为未开启并可重新引导。

- [ ] **Step 3: 更新文档**

- `README.md`：新增「安卓 App」章节（构建：`cd android && ./gradlew assembleDebug`；安装：侧载 APK；使用：开启无障碍 → 划词翻译 / 网页翻译）。
- `AGENTS.md`：仓库结构与测试命令确认与最终状态一致（`android/` 测试命令 `./gradlew :app:testDebugUnitTest`）；供应商扩展流程确认包含 `android/app/src/main/java/com/yuxtrans/app/core/Constants.kt`。
- `CHANGELOG.md`：Unreleased 的 Added 补全安卓 v1 功能列表。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add android app usage and build instructions"
```

---

## 已知取舍与风险提示

1. **剪贴板兜底**未进 v1 的 CaptureService（部分 App 不上报文本选择事件）——若真机验证发现常用 App 无法触发，在 CaptureService 中补 `ClipboardManager.OnPrimaryClipChangedListener`。
2. **`@JavascriptInterface` 同步桥**在批量翻译时阻塞 JS 线程，与扩展的请求-响应模型一致；若实测页面卡顿/ANR，改异步回调桥。
3. **v1.1 全局屏幕翻译**不在本计划内（见 spec §6），待 v1 验收后单独 brainstorm + plan。
4. **qwen SSE 与 anthropic SSE 各需一次真实流式回归**（扩展侧无单测覆盖，移植后用真 key 验证一次）。
