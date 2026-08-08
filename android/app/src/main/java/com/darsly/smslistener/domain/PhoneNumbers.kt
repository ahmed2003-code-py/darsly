package com.darsly.smslistener.domain

/**
 * Client-side phone validation — a courtesy so the user is told about a typo
 * before a round trip, not a security control. The backend re-validates and
 * normalizes to E.164, and only an OTP it sent can bind a number to a device.
 *
 * Mirrors the API's `EGY_PHONE_REGEX`.
 */
object PhoneNumbers {

    private val EGYPTIAN = Regex("^(\\+20|0020|20|0)?1[0125][0-9]{8}$")

    /** Users paste numbers with spaces, dashes and parentheses; strip them first. */
    fun sanitize(input: String): String = input.filter { it.isDigit() || it == '+' }

    fun isValid(input: String): Boolean = EGYPTIAN.matches(sanitize(input))
}
