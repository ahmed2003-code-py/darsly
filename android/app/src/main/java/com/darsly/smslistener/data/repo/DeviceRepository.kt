package com.darsly.smslistener.data.repo

import com.darsly.smslistener.data.remote.DeviceApi
import com.darsly.smslistener.data.remote.RequestOtpRequest
import com.darsly.smslistener.data.remote.VerifyOtpRequest
import com.darsly.smslistener.data.security.DeviceSession
import com.darsly.smslistener.data.security.SessionStore
import kotlinx.coroutines.flow.StateFlow

/**
 * Device registration and lifecycle.
 *
 * The phone number the user types is only a *claim*; it becomes the device
 * identity solely after the backend confirms an OTP it sent to that number. The
 * app never asserts a phone number to any other endpoint — every later call is
 * authenticated by the device JWT issued at verification.
 */
class DeviceRepository(
    private val api: DeviceApi,
    private val session: SessionStore,
    private val smsRepository: SmsRepository,
    private val deviceModel: String,
    private val appVersion: String,
) {

    val registered: StateFlow<Boolean> = session.registered

    fun verifiedPhone(): String? = session.phone()

    fun deviceId(): String? = session.deviceId()

    fun isRegistered(): Boolean = session.isRegistered()

    /** Ask the backend to send an OTP. Returns its validity window in seconds. */
    suspend fun requestOtp(phone: String): ApiOutcome<Int> = apiCall {
        api.requestOtp(RequestOtpRequest(phone.trim())).expiresInSeconds
    }

    /**
     * Verify the OTP and register this device. On success the tokens are written
     * to Keystore-backed storage and the sender rules are pulled immediately, so
     * classification is correct before the first SMS can arrive.
     */
    suspend fun verifyOtp(phone: String, code: String): ApiOutcome<Unit> {
        val outcome = apiCall {
            api.verifyOtp(
                VerifyOtpRequest(
                    phone = phone.trim(),
                    code = code.trim(),
                    model = deviceModel,
                    appVersion = appVersion,
                ),
            )
        }
        return when (outcome) {
            is ApiOutcome.Failure -> outcome
            is ApiOutcome.Success -> {
                val tokens = outcome.value
                session.save(
                    DeviceSession(
                        accessToken = tokens.accessToken,
                        refreshToken = tokens.refreshToken,
                        deviceId = tokens.deviceId,
                        phone = tokens.phone ?: phone.trim(),
                    ),
                )
                // Best-effort: a failure here only means the bootstrap rules stay
                // in use until the next sync, so it must not fail verification.
                smsRepository.refreshRules()
                ApiOutcome.Success(Unit)
            }
        }
    }

    /** Liveness ping; doubles as the Settings "backend connection" probe. */
    suspend fun heartbeat(): ApiOutcome<Unit> = apiCall { api.heartbeat() }.map { }

    suspend fun refreshRules(): ApiOutcome<Int> = smsRepository.refreshRules()

    /**
     * Secure logout. The server revokes the device first; local state is then wiped
     * regardless of the outcome, so a user can always disconnect a phone even with
     * no connectivity — and the server-side token is invalidated on next contact.
     */
    suspend fun unregister(): ApiOutcome<Unit> {
        val outcome = apiCall { api.unregister() }
        smsRepository.deleteAllMessages()
        session.clear()
        return outcome.map { }
    }

    suspend fun deleteLocalMessages() = smsRepository.deleteAllMessages()
}

private fun <T, R> ApiOutcome<T>.map(transform: (T) -> R): ApiOutcome<R> = when (this) {
    is ApiOutcome.Success -> ApiOutcome.Success(transform(value))
    is ApiOutcome.Failure -> this
}
