package com.darsly.smslistener.data

import com.darsly.smslistener.data.remote.ApiClient
import com.darsly.smslistener.data.repo.SmsRepository
import com.darsly.smslistener.data.repo.SyncOutcome
import com.darsly.smslistener.data.security.DeviceSession
import com.darsly.smslistener.sms.ReceivedSms
import com.darsly.smslistener.testing.FakeSenderRuleDao
import com.darsly.smslistener.testing.FakeSessionStore
import com.darsly.smslistener.testing.FakeSmsMessageDao
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Expired-token handling: refresh transparently, but never discard a session by mistake. */
class TokenRefreshTest {

    private lateinit var server: MockWebServer
    private lateinit var session: FakeSessionStore
    private lateinit var messages: FakeSmsMessageDao
    private lateinit var repository: SmsRepository

    private val sms = ReceivedSms("CIB", "Credited EGP 5,000", 1_754_632_320_000)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        session = FakeSessionStore(DeviceSession("expired", "refresh-1", "dev-1", "+201012345678"))
        messages = FakeSmsMessageDao()
        repository = SmsRepository(
            messages,
            FakeSenderRuleDao(),
            ApiClient.create(server.url("/api/v1/").toString(), session),
        )
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    @Test
    fun `an expired access token is refreshed and the upload replayed`() = runTest {
        repository.onSmsReceived(sms)

        server.enqueue(MockResponse().setResponseCode(401)) // sms-events, token expired
        server.enqueue(
            json("""{"accessToken":"fresh","refreshToken":"refresh-2","deviceId":"dev-1"}"""),
        )
        server.enqueue(json("""{"eventId":"evt-1","status":"MATCHED"}""")) // replay

        assertEquals(SyncOutcome.DONE, repository.syncPending())

        assertEquals("fresh", session.accessToken())
        assertEquals("refresh-2", session.refreshToken())

        assertEquals("/api/v1/device/sms-events", server.takeRequest().path)
        assertEquals("/api/v1/device/auth/refresh", server.takeRequest().path)
        val replay = server.takeRequest()
        assertEquals("/api/v1/device/sms-events", replay.path)
        assertEquals("Bearer fresh", replay.getHeader("Authorization"))
    }

    @Test
    fun `a rejected refresh token clears the session — the device was revoked`() = runTest {
        repository.onSmsReceived(sms)

        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(401)) // refresh rejected

        repository.syncPending()

        assertTrue(session.cleared)
        assertFalse(session.registered.value)
    }

    @Test
    fun `a refresh that fails on the network keeps the session intact`() = runTest {
        repository.onSmsReceived(sms)

        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(503)) // refresh temporarily unavailable

        assertEquals(SyncOutcome.RETRY, repository.syncPending())

        // The credentials may be perfectly valid — a backend blip must not force
        // the user to re-verify, and the message stays queued.
        assertFalse(session.cleared)
        assertEquals("expired", session.accessToken())
    }

    private fun json(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
