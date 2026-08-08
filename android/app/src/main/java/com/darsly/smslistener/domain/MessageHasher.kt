package com.darsly.smslistener.domain

import java.security.MessageDigest

/**
 * Deterministic idempotency id for a received SMS.
 *
 * `SHA-256(normalizedSender + " " + body + " " + receivedAtEpochSeconds)`
 *
 * Identical to the backend's `messageHash()` so the two dedupe on the same key.
 * It is the local primary key of the outbox *and* the server's
 * `UNIQUE(deviceId, messageHash)` — a message re-delivered by the platform, or a
 * POST retried after an ambiguous network failure, resolves to the same row on
 * both sides and can never be counted twice.
 */
object MessageHasher {

    fun hash(sender: String?, body: String?, receivedAtMillis: Long): String {
        val epochSeconds = Math.floorDiv(receivedAtMillis, 1000L)
        val input = "${SenderClassifier.normalizeSender(sender)} ${body ?: ""} $epochSeconds"
        return sha256Hex(input)
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val out = StringBuilder(digest.size * 2)
        for (byte in digest) {
            val value = byte.toInt() and 0xFF
            out.append(HEX[value ushr 4]).append(HEX[value and 0x0F])
        }
        return out.toString()
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
