package com.darsly.smslistener.data.remote

import kotlinx.serialization.Serializable

// Wire contract for /api/v1/device/* — see docs/android-sms-listener.md.
// Every response type tolerates unknown/extra fields (Json { ignoreUnknownKeys })
// so a backend that adds a field cannot break an already-deployed device.

/**
 * Redeem an admin-issued enrollment code. The device never claims a phone number
 * — the number is bound to the code when an admin mints it, and comes back in the
 * response.
 */
@Serializable
data class EnrollRequest(
    val code: String,
    val model: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class DeviceTokensResponse(
    val accessToken: String,
    val refreshToken: String,
    val deviceId: String,
    val phone: String? = null,
)

@Serializable
data class DeviceMeResponse(
    val id: String,
    val phone: String,
    val platform: String? = null,
    val model: String? = null,
    val appVersion: String? = null,
    val revokedAt: String? = null,
    val lastSeenAt: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class HeartbeatResponse(val ok: Boolean = true, val serverTime: String? = null)

@Serializable
data class OkResponse(val ok: Boolean = true)

@Serializable
data class SenderRuleDto(
    val brand: String,
    val matchType: String,
    val pattern: String,
    val provider: String,
    val enabled: Boolean = true,
    val forwardToBackend: Boolean = true,
    val priority: Int = 100,
)

@Serializable
data class SmsEventRequest(
    val sender: String,
    val message: String,
    /** ISO-8601 UTC, e.g. 2026-08-08T06:12:00Z. */
    val receivedAt: String,
    val messageHash: String,
    val simSlot: Int? = null,
    val subscriptionId: Int? = null,
)

@Serializable
data class SmsEventResponse(
    val eventId: String? = null,
    val duplicate: Boolean = false,
    val brand: String? = null,
    val provider: String? = null,
    val amountCents: Int? = null,
    val reference: String? = null,
    val forwarded: Boolean = false,
    /** MATCHED | UNMATCHED | AMBIGUOUS | DUPLICATE | LOCAL_ONLY */
    val status: String? = null,
)
