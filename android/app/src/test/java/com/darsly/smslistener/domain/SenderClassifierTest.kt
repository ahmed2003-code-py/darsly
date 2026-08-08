package com.darsly.smslistener.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SenderClassifierTest {

    private val rules = listOf(
        SenderRule("CIB", SenderMatchType.CONTAINS, "cib", "BANK_TRANSFER", priority = 10),
        SenderRule("Vodafone Cash", SenderMatchType.CONTAINS, "vodafone", "VODAFONE_CASH", priority = 20),
        SenderRule("InstaPay", SenderMatchType.CONTAINS, "instapay", "INSTAPAY", priority = 30),
    )

    @Test
    fun `matches a sender id that is not exactly the brand name`() {
        // The whole reason CONTAINS is the default match type: real sender ids are
        // "CIB-Bank", "VodafoneCash", "InstaPay-EG" — never the display brand.
        assertEquals("CIB", SenderClassifier.classify("CIB-Bank", rules)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VodafoneCash", rules)?.brand)
        assertEquals("InstaPay", SenderClassifier.classify("InstaPay-EG", rules)?.brand)
    }

    @Test
    fun `separators in the sender id do not defeat a rule`() {
        // Found on a real handset: Vodafone Cash sends from "VF-Cash", while the
        // rule was written "vfcash", so a genuine payment SMS was filed as
        // local-only. One rule must cover every spelling of the same brand.
        val defaults = BootstrapRules.DEFAULTS
        assertEquals("Vodafone Cash", SenderClassifier.classify("VF-Cash", defaults)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VF Cash", defaults)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VF_Cash", defaults)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VF.Cash", defaults)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VFCash", defaults)?.brand)
        assertEquals("CIB", SenderClassifier.classify("CIB-Bank", defaults)?.brand)
    }

    @Test
    fun `separator stripping is for matching only and never touches the hash`() {
        // The message hash must keep using normalizeSender, or changing matching
        // would silently break idempotency against already-delivered events.
        assertEquals("vf-cash", SenderClassifier.normalizeSender("VF-Cash"))
        assertEquals("vfcash", SenderClassifier.matchKey("VF-Cash"))
    }

    @Test
    fun `matching is case and whitespace insensitive`() {
        assertEquals("CIB", SenderClassifier.classify("  cIb   bank ", rules)?.brand)
    }

    @Test
    fun `unknown senders stay local`() {
        assertNull(SenderClassifier.classify("+201001234567", rules))
        assertNull(SenderClassifier.classify("Mum", rules))
        assertNull(SenderClassifier.classify("", rules))
    }

    @Test
    fun `lower priority wins when several rules match`() {
        val overlapping = listOf(
            SenderRule("Generic", SenderMatchType.CONTAINS, "cib", "OTHER", priority = 99),
            SenderRule("CIB", SenderMatchType.CONTAINS, "cib", "BANK_TRANSFER", priority = 10),
        )
        assertEquals("CIB", SenderClassifier.classify("CIB", overlapping)?.brand)
    }

    @Test
    fun `disabled rules are ignored`() {
        val disabled = listOf(
            SenderRule("CIB", SenderMatchType.CONTAINS, "cib", "BANK_TRANSFER", enabled = false),
        )
        assertNull(SenderClassifier.classify("CIB", disabled))
    }

    @Test
    fun `forwardToBackend false classifies but does not forward`() {
        val watchOnly = listOf(
            SenderRule("Etisalat", SenderMatchType.CONTAINS, "etisalat", "OTHER", forwardToBackend = false),
        )
        val result = SenderClassifier.classify("Etisalat", watchOnly)
        assertEquals("Etisalat", result?.brand)
        assertEquals(false, result?.forwardToBackend)
    }

    @Test
    fun `exact match does not match a substring`() {
        val exact = listOf(SenderRule("CIB", SenderMatchType.EXACT, "cib", "BANK_TRANSFER"))
        assertEquals("CIB", SenderClassifier.classify("CIB", exact)?.brand)
        assertNull(SenderClassifier.classify("CIB-Bank", exact))
    }

    @Test
    fun `regex rules are supported`() {
        val regex = listOf(
            SenderRule("CIB", SenderMatchType.REGEX, "^cib(-?bank)?$", "BANK_TRANSFER"),
        )
        assertEquals("CIB", SenderClassifier.classify("CIB-Bank", regex)?.brand)
        assertNull(SenderClassifier.classify("NotCIB", regex))
    }

    @Test
    fun `a malformed backend regex never throws`() {
        // A bad pattern pushed from the server must degrade to "no match" rather
        // than crash the SMS receiver.
        val broken = listOf(SenderRule("Broken", SenderMatchType.REGEX, "([unclosed", "OTHER"))
        assertNull(SenderClassifier.classify("anything", broken))
    }

    @Test
    fun `bootstrap defaults classify the expected Egyptian senders`() {
        val defaults = BootstrapRules.DEFAULTS
        assertEquals("CIB", SenderClassifier.classify("CIB", defaults)?.brand)
        assertEquals("Vodafone Cash", SenderClassifier.classify("VFCash", defaults)?.brand)
        assertEquals("InstaPay", SenderClassifier.classify("InstaPay", defaults)?.brand)
        assertTrue(defaults.all { it.forwardToBackend })
    }
}
