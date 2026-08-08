package com.darsly.smslistener.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncPolicyTest {

    @Test
    fun `2xx is success`() {
        assertEquals(SyncDecision.SUCCESS, SyncPolicy.forHttpStatus(200))
        assertEquals(SyncDecision.SUCCESS, SyncPolicy.forHttpStatus(201))
        assertEquals(SyncDecision.SUCCESS, SyncPolicy.forHttpStatus(204))
    }

    @Test
    fun `server errors are retried`() {
        assertEquals(SyncDecision.RETRY, SyncPolicy.forHttpStatus(500))
        assertEquals(SyncDecision.RETRY, SyncPolicy.forHttpStatus(502))
        assertEquals(SyncDecision.RETRY, SyncPolicy.forHttpStatus(503))
    }

    @Test
    fun `rate limiting and timeouts are retried, not dropped`() {
        assertEquals(SyncDecision.RETRY, SyncPolicy.forHttpStatus(429))
        assertEquals(SyncDecision.RETRY, SyncPolicy.forHttpStatus(408))
    }

    @Test
    fun `auth failures are their own category so the token can be refreshed`() {
        assertEquals(SyncDecision.UNAUTHORIZED, SyncPolicy.forHttpStatus(401))
        assertEquals(SyncDecision.UNAUTHORIZED, SyncPolicy.forHttpStatus(403))
    }

    @Test
    fun `other 4xx are permanent — retrying a rejected payload is pointless`() {
        assertEquals(SyncDecision.PERMANENT_FAILURE, SyncPolicy.forHttpStatus(400))
        assertEquals(SyncDecision.PERMANENT_FAILURE, SyncPolicy.forHttpStatus(404))
        assertEquals(SyncDecision.PERMANENT_FAILURE, SyncPolicy.forHttpStatus(422))
    }

    @Test
    fun `network failures are always retried`() {
        assertEquals(SyncDecision.RETRY, SyncPolicy.forNetworkError())
    }

    @Test
    fun `attempts are bounded but generous`() {
        assertFalse(SyncPolicy.exhausted(1))
        assertFalse(SyncPolicy.exhausted(SyncPolicy.MAX_ATTEMPTS - 1))
        assertTrue(SyncPolicy.exhausted(SyncPolicy.MAX_ATTEMPTS))
    }
}
