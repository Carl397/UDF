# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Capacitor / WebView bridge (release minifyEnabled true) ───────────────
# Capacitor instantiates the bridge and plugins by class name (reflection) and
# exposes native methods to JavaScript. Keep that surface so R8 shrinking does
# not strip or rename it. Capacitor libs also ship consumer rules; these are
# belt-and-braces for a web app whose value is entirely in the JS bridge.
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep class com.ionicframework.** { *; }
-keep public class com.udf.party.** { *; }

# Keep native methods callable from JS (plugin + @JavascriptInterface).
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
    @android.webkit.JavascriptInterface public <methods>;
}

# FileProvider is referenced by name in AndroidManifest.xml.
-keep class androidx.core.content.FileProvider { *; }

# Preserve line numbers for readable crash stack traces, hide the source name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
