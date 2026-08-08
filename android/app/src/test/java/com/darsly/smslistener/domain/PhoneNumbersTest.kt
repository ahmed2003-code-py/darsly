package com.darsly.smslistener.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneNumbersTest {

    @Test
    fun `accepts the Egyptian formats the backend accepts`() {
        assertTrue(PhoneNumbers.isValid("01012345678"))
        assertTrue(PhoneNumbers.isValid("+201012345678"))
        assertTrue(PhoneNumbers.isValid("00201112345678"))
        assertTrue(PhoneNumbers.isValid("201212345678"))
        assertTrue(PhoneNumbers.isValid("01512345678"))
    }

    @Test
    fun `rejects malformed input`() {
        assertFalse(PhoneNumbers.isValid(""))
        assertFalse(PhoneNumbers.isValid("0101234567")) // one digit short
        assertFalse(PhoneNumbers.isValid("010123456789")) // one digit long
        assertFalse(PhoneNumbers.isValid("01312345678")) // no such operator prefix
        assertFalse(PhoneNumbers.isValid("not a number"))
    }

    @Test
    fun `strips formatting users actually paste`() {
        assertEquals("01012345678", PhoneNumbers.sanitize("010 1234 5678"))
        assertEquals("+201012345678", PhoneNumbers.sanitize("+20 (10) 1234-5678"))
        assertTrue(PhoneNumbers.isValid("010 1234 5678"))
    }
}
