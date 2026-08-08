package com.darsly.smslistener.sms

import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager

/** One incoming SMS, already reassembled from its (possibly multipart) PDUs. */
data class ReceivedSms(
    val sender: String,
    val body: String,
    val receivedAtMillis: Long,
    val subscriptionId: Int? = null,
    val simSlot: Int? = null,
)

/**
 * Turns an `SMS_RECEIVED` broadcast into a [ReceivedSms].
 *
 * [assemble] holds all the logic and is a pure function, so multipart
 * reassembly and dual-SIM handling are unit-testable without an emulator;
 * [fromIntent] only does the framework plumbing.
 */
object SmsExtractor {

    /**
     * A long SMS arrives as several PDUs in a single broadcast. Concatenating the
     * parts in order is what makes the body — and therefore the message hash —
     * stable, which is what dedupe depends on.
     */
    fun assemble(
        sender: String?,
        bodies: List<String>,
        timestampMillis: Long,
        subscriptionId: Int? = null,
        simSlot: Int? = null,
    ): ReceivedSms? {
        val body = bodies.joinToString(separator = "")
        val normalizedSender = sender?.trim().orEmpty()
        if (normalizedSender.isEmpty() && body.isEmpty()) return null
        return ReceivedSms(
            sender = normalizedSender,
            body = body,
            receivedAtMillis = timestampMillis,
            subscriptionId = subscriptionId,
            simSlot = simSlot,
        )
    }

    fun fromIntent(intent: Intent, slotResolver: SimSlotResolver? = null): ReceivedSms? {
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (parts.isNullOrEmpty()) return null

        val first = parts[0]
        val subscriptionId = readSubscriptionId(intent)
        return assemble(
            // displayOriginatingAddress resolves alphanumeric sender ids ("CIB")
            // rather than only numeric ones.
            sender = first.displayOriginatingAddress ?: first.originatingAddress,
            bodies = parts.mapNotNull { it.displayMessageBody },
            // The message's own service-centre timestamp, not time-of-processing:
            // it is identical across redeliveries, which keeps the hash stable.
            timestampMillis = first.timestampMillis,
            subscriptionId = subscriptionId,
            simSlot = subscriptionId?.let { slotResolver?.slotFor(it) },
        )
    }

    /**
     * Dual-SIM: the broadcast carries the receiving subscription. Never assume a
     * single SIM — and never assume the extra is present either, since not every
     * OEM/Android version supplies it.
     */
    private fun readSubscriptionId(intent: Intent): Int? {
        val extras = intent.extras ?: return null
        for (key in SUBSCRIPTION_EXTRA_KEYS) {
            if (!extras.containsKey(key)) continue
            val value = extras.getInt(key, INVALID_SUBSCRIPTION)
            if (value != INVALID_SUBSCRIPTION && value >= 0) return value
        }
        return null
    }

    private const val INVALID_SUBSCRIPTION = SubscriptionManager.INVALID_SUBSCRIPTION_ID

    private val SUBSCRIPTION_EXTRA_KEYS = listOf(
        "subscription", // the long-standing key on the SMS_RECEIVED broadcast
        "android.telephony.extra.SUBSCRIPTION_INDEX",
    )
}
