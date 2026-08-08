package com.darsly.smslistener.domain

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class MessageHasherTest {

    private val body = "Your account was credited with EGP 5,000. Ref 884213"

    @Test
    fun `is deterministic for the same message`() {
        val first = MessageHasher.hash("CIB", body, 1_754_632_320_000)
        val second = MessageHasher.hash("CIB", body, 1_754_632_320_000)
        assertEquals(first, second)
    }

    @Test
    fun `produces a 64 character lowercase hex digest`() {
        val hash = MessageHasher.hash("CIB", body, 1_754_632_320_000)
        assertEquals(64, hash.length)
        assertEquals(hash.lowercase(), hash)
        assertEquals(true, hash.all { it in "0123456789abcdef" })
    }

    @Test
    fun `differs when any component differs`() {
        val base = MessageHasher.hash("CIB", body, 1_754_632_320_000)
        assertNotEquals(base, MessageHasher.hash("InstaPay", body, 1_754_632_320_000))
        assertNotEquals(base, MessageHasher.hash("CIB", body + ".", 1_754_632_320_000))
        assertNotEquals(base, MessageHasher.hash("CIB", body, 1_754_632_321_000))
    }

    @Test
    fun `sender normalization means casing cannot create a second event`() {
        // Two deliveries of one message that differ only in how the sender id was
        // cased must not both be forwarded.
        assertEquals(
            MessageHasher.hash("CIB", body, 1_754_632_320_000),
            MessageHasher.hash(" cib ", body, 1_754_632_320_000),
        )
    }

    @Test
    fun `sub-second jitter within the same second does not change the hash`() {
        // The contract hashes whole epoch seconds, matching the backend.
        assertEquals(
            MessageHasher.hash("CIB", body, 1_754_632_320_000),
            MessageHasher.hash("CIB", body, 1_754_632_320_999),
        )
    }

    @Test
    fun `matches the backend formula exactly`() {
        // The backend computes SHA-256(normalizedSender + ' ' + body + ' ' + epochSec).
        // If either side ever changes, idempotency silently breaks — so pin it.
        val epochSeconds = 1_754_632_320_000L / 1000
        val expected = MessageDigest.getInstance("SHA-256")
            .digest("cib $body $epochSeconds".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        assertEquals(expected, MessageHasher.hash("CIB", body, 1_754_632_320_000))
    }

    @Test
    fun `handles arabic bodies`() {
        val arabic = "استلمت 450 ج.م، رقم العملية 884213"
        val hash = MessageHasher.hash("VodafoneCash", arabic, 1_754_632_320_000)
        assertEquals(64, hash.length)
        assertEquals(hash, MessageHasher.hash("vodafonecash", arabic, 1_754_632_320_000))
    }
}
