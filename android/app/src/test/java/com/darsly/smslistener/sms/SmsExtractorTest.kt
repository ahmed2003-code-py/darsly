package com.darsly.smslistener.sms

import com.darsly.smslistener.domain.MessageHasher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Parsing rules that dedupe depends on. [SmsExtractor.assemble] is deliberately
 * pure so this needs no emulator.
 */
class SmsExtractorTest {

    @Test
    fun `a single part message is parsed as-is`() {
        val sms = SmsExtractor.assemble("CIB", listOf("Credited EGP 5,000"), 1_754_632_320_000)

        assertNotNull(sms)
        assertEquals("CIB", sms!!.sender)
        assertEquals("Credited EGP 5,000", sms.body)
        assertEquals(1_754_632_320_000, sms.receivedAtMillis)
    }

    @Test
    fun `multipart messages are concatenated in order`() {
        // A long SMS arrives as several PDUs; joining them in order is what makes
        // the body — and therefore the hash — stable.
        val sms = SmsExtractor.assemble(
            sender = "CIB",
            bodies = listOf("Your account was credited ", "with EGP 5,000. ", "Ref 884213"),
            timestampMillis = 1_754_632_320_000,
        )

        assertEquals("Your account was credited with EGP 5,000. Ref 884213", sms?.body)
    }

    @Test
    fun `a multipart message hashes the same as the equivalent single part one`() {
        val split = SmsExtractor.assemble("CIB", listOf("Credited ", "EGP 5,000"), 1_000_000)!!
        val whole = SmsExtractor.assemble("CIB", listOf("Credited EGP 5,000"), 1_000_000)!!

        assertEquals(
            MessageHasher.hash(whole.sender, whole.body, whole.receivedAtMillis),
            MessageHasher.hash(split.sender, split.body, split.receivedAtMillis),
        )
    }

    @Test
    fun `dual SIM metadata is carried through when present`() {
        val sms = SmsExtractor.assemble(
            sender = "VodafoneCash",
            bodies = listOf("استلمت 450 ج.م"),
            timestampMillis = 1_754_632_320_000,
            subscriptionId = 3,
            simSlot = 1,
        )

        assertEquals(3, sms?.subscriptionId)
        assertEquals(1, sms?.simSlot)
    }

    @Test
    fun `a single SIM device simply has no subscription information`() {
        val sms = SmsExtractor.assemble("CIB", listOf("Credited EGP 5,000"), 1_754_632_320_000)

        assertNull(sms?.subscriptionId)
        assertNull(sms?.simSlot)
    }

    @Test
    fun `sender whitespace is trimmed`() {
        assertEquals("CIB", SmsExtractor.assemble("  CIB  ", listOf("x"), 1)?.sender)
    }

    @Test
    fun `an entirely empty broadcast is discarded`() {
        assertNull(SmsExtractor.assemble(null, emptyList(), 1))
        assertNull(SmsExtractor.assemble("", listOf(""), 1))
    }

    @Test
    fun `a body-less message from a known sender is still kept`() {
        // Rare, but it is not our place to silently drop it.
        assertNotNull(SmsExtractor.assemble("CIB", emptyList(), 1))
    }
}
