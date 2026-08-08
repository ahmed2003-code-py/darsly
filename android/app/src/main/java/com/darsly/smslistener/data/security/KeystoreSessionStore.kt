package com.darsly.smslistener.data.security

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Device tokens at rest, encrypted with an AES-256-GCM key held in the Android
 * Keystore (hardware-backed where the device supports it).
 *
 * Tokens are never written to plain SharedPreferences, never logged, and never
 * included in a backup — `allowBackup=false` plus the exclusion rules in
 * `data_extraction_rules.xml` keep them on the phone that was authorized.
 */
class KeystoreSessionStore(context: Context) : SessionStore {

    private val prefs: SharedPreferences = run {
        val appContext = context.applicationContext
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private val _registered = MutableStateFlow(readSession() != null)
    override val registered: StateFlow<Boolean> = _registered.asStateFlow()

    override fun session(): DeviceSession? = readSession()

    override fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)

    override fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)

    override fun deviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)

    override fun phone(): String? = prefs.getString(KEY_PHONE, null)

    override fun save(session: DeviceSession) {
        prefs.edit()
            .putString(KEY_ACCESS, session.accessToken)
            .putString(KEY_REFRESH, session.refreshToken)
            .putString(KEY_DEVICE_ID, session.deviceId)
            .putString(KEY_PHONE, session.phone)
            .apply()
        _registered.value = true
    }

    override fun updateTokens(accessToken: String, refreshToken: String) {
        prefs.edit()
            .putString(KEY_ACCESS, accessToken)
            .putString(KEY_REFRESH, refreshToken)
            .apply()
    }

    override fun clear() {
        prefs.edit().clear().apply()
        _registered.value = false
    }

    private fun readSession(): DeviceSession? {
        val access = prefs.getString(KEY_ACCESS, null) ?: return null
        val refresh = prefs.getString(KEY_REFRESH, null) ?: return null
        val deviceId = prefs.getString(KEY_DEVICE_ID, null) ?: return null
        return DeviceSession(access, refresh, deviceId, prefs.getString(KEY_PHONE, null))
    }

    private companion object {
        const val PREFS_NAME = "darsly_device_session"
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_PHONE = "phone"
    }
}
