package com.darsly.smslistener.data

import com.darsly.smslistener.data.remote.ApiClient
import com.darsly.smslistener.data.repo.ApiError
import com.darsly.smslistener.data.repo.ApiOutcome
import com.darsly.smslistener.data.repo.DeviceRepository
import com.darsly.smslistener.data.repo.SmsRepository
import com.darsly.smslistener.testing.FakeSenderRuleDao
import com.darsly.smslistener.testing.FakeSessionStore
import com.darsly.smslistener.testing.FakeSmsMessageDao
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Device enrollment: redeem an admin-issued code, and every failure the screen has
 * a distinct state for.
 */
class EnrollmentTest {

    private lateinit var server: MockWebServer
    private lateinit var session: FakeSessionStore
    private lateinit var devices: DeviceRepository

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        session = FakeSessionStore()
        val api = ApiClient.create(server.url("/api/v1/").toString(), session)
        val sms = SmsRepository(FakeSmsMessageDao(), FakeSenderRuleDao(), api)
        devices = DeviceRepository(api, session, sms, deviceModel = "Pixel 7", appVersion = "1.0.0")
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    @Test
    fun `a valid code registers the device and pulls the sender rules`() = runTest {
        server.enqueue(
            json("""{"accessToken":"access-1","refreshToken":"refresh-1","deviceId":"dev-1","phone":"+201002589923"}"""),
        )
        server.enqueue(json("""[]""")) // GET /device/sms-rules

        val outcome = devices.enroll("K7QM3XPD")

        assertTrue(outcome is ApiOutcome.Success)
        assertEquals("access-1", session.accessToken())
        assertEquals("dev-1", session.deviceId())
        // The number comes from the server — the device never asserts one.
        assertEquals("+201002589923", session.phone())

        val request = server.takeRequest()
        assertEquals("/api/v1/device/auth/enroll", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains("K7QM3XPD"))
        assertTrue(body.contains("Pixel 7"))
        // Nothing in the request lets the handset choose its own identity.
        assertFalse(body.contains("phone"))

        val rulesRequest = server.takeRequest()
        assertEquals("/api/v1/device/sms-rules", rulesRequest.path)
        assertEquals("Bearer access-1", rulesRequest.getHeader("Authorization"))
    }

    @Test
    fun `a wrong or expired code leaves the device unregistered`() = runTest {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"message":"Invalid or expired enrollment code"}"""))

        val outcome = devices.enroll("AAAABBBB")

        assertEquals(ApiError.INVALID_CODE, (outcome as ApiOutcome.Failure).error)
        assertNull(session.accessToken())
        assertFalse(devices.isRegistered())
    }

    @Test
    fun `rate limiting is reported distinctly so the user is told to wait`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429))

        val outcome = devices.enroll("K7QM3XPD")

        assertEquals(ApiError.RATE_LIMITED, (outcome as ApiOutcome.Failure).error)
    }

    @Test
    fun `no connectivity surfaces as a network error, not a bad code`() = runTest {
        server.shutdown()

        val outcome = devices.enroll("K7QM3XPD")

        assertEquals(ApiError.NETWORK, (outcome as ApiOutcome.Failure).error)
        assertFalse(devices.isRegistered())
    }

    @Test
    fun `a failing rules fetch does not undo a successful enrollment`() = runTest {
        server.enqueue(json("""{"accessToken":"a","refreshToken":"r","deviceId":"d","phone":"+201002589923"}"""))
        server.enqueue(MockResponse().setResponseCode(500))

        val outcome = devices.enroll("K7QM3XPD")

        assertTrue(outcome is ApiOutcome.Success)
        assertTrue(devices.isRegistered())
    }

    private fun json(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
