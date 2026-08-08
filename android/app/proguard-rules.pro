# Retrofit / OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn retrofit2.**
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response

# kotlinx.serialization — keep generated serializers for our DTOs
-keepclassmembers class com.darsly.smslistener.** {
    *** Companion;
}
-keepclasseswithmembers class com.darsly.smslistener.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.darsly.smslistener.data.remote.**$$serializer { *; }

# Room
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# Tink (pulled in by androidx.security-crypto for the Keystore-backed prefs)
# references Error Prone annotations that are compile-only and absent at runtime.
-dontwarn com.google.errorprone.annotations.**

# Strip all logging from release builds so no SMS body / token can ever reach
# logcat on a shipped device.
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}
