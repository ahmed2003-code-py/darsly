package com.darsly.smslistener.data.security

import kotlinx.coroutines.flow.StateFlow

/** The verified device session. */
data class DeviceSession(
    val accessToken: String,
    val refreshToken: String,
    val deviceId: String,
    val phone: String?,
)

/**
 * Storage for the device credentials.
 *
 * An interface so the networking and repository layers can be exercised in plain
 * JVM tests with an in-memory fake — the production implementation
 * ([KeystoreSessionStore]) needs a real Android Keystore.
 */
interface SessionStore {

    /** Emits `true` while a verified device session exists. Drives app routing. */
    val registered: StateFlow<Boolean>

    fun session(): DeviceSession?

    fun accessToken(): String?

    fun refreshToken(): String?

    fun deviceId(): String?

    fun phone(): String?

    fun isRegistered(): Boolean = session() != null

    fun save(session: DeviceSession)

    /** Replace just the token pair after a refresh, keeping device id and phone. */
    fun updateTokens(accessToken: String, refreshToken: String)

    fun clear()
}
