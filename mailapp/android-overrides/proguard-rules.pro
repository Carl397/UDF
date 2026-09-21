# UDF secure-mail release ProGuard/R8 rules (minifyEnabled true).

# ── Capacitor / WebView bridge ─────────────────────────────────────────────
# Capacitor instantiates the bridge and plugins reflectively by class name and
# exposes native methods to JavaScript; keep that surface so R8 shrinking does
# not strip or rename it. This wrapper has NO custom @JavascriptInterface of its
# own (it only loads the remote webmail), so the keep set is intentionally small.
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.** { *; }
-keep class com.ionicframework.** { *; }
-keep public class com.udf.mail.** { *; }

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
