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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The registration flow against a stubbed backend: request OTP → verify → device
 * registered. Covers each failure the UI has a distinct state for.
 */
class OtpFlowTest {

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
    fun `requesting an OTP posts the phone number and returns the validity window`() = runTest {
        server.enqueue(json("""{"expiresInSeconds":300}"""))

        val outcome = devices.requestOtp("010 1234 5678")

        assertTrue(outcome is ApiOutcome.Success)
        assertEquals(300, (outcome as ApiOutcome.Success).value)

        val request = server.takeRequest()
        assertEquals("/api/v1/device/auth/request-otp", request.path)
        assertEquals("POST", request.method)
        assertTrue(request.body.readUtf8().contains("010 1234 5678"))
    }

    @Test
    fun `verifying stores the device session and pulls the sender rules`() = runTest {
        server.enqueue(
            json(
                """{"accessToken":"access-1","refreshToken":"refresh-1","deviceId":"dev-1","phone":"+201012345678"}""",
            ),
        )
        server.enqueue(json("""[]""")) // GET /device/sms-rules

        val outcome = devices.verifyOtp("01012345678", "0000")

        assertTrue(outcome is ApiOutcome.Success)
        assertEquals("access-1", session.accessToken())
        assertEquals("dev-1", session.deviceId())
        // The server's normalized E.164 number wins over what the user typed.
        assertEquals("+201012345678", session.phone())

        assertEquals("/api/v1/device/auth/verify-otp", server.takeRequest().path)
        val rulesRequest = server.takeRequest()
        assertEquals("/api/v1/device/sms-rules", rulesRequest.path)
        // Rules are fetched with the freshly issued token.
        assertEquals("Bearer access-1", rulesRequest.getHeader("Authorization"))
    }

    @Test
    fun `a wrong code leaves the device unregistered`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"Invalid code"}"""))

        val outcome = devices.verifyOtp("01012345678", "1234")

        assertEquals(ApiError.INVALID_CODE, (outcome as ApiOutcome.Failure).error)
        assertNull(session.accessToken())
        assertEquals(false, devices.isRegistered())
    }

    @Test
    fun `rate limiting is reported distinctly so the user is told to wait`() = runTest {
        server.enqueue(MockResponse().setResponseCode(429))

        val outcome = devices.requestOtp("01012345678")

        assertEquals(ApiError.RATE_LIMITED, (outcome as ApiOutcome.Failure).error)
    }

    @Test
    fun `a server error is not reported as a wrong code`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))

        val outcome = devices.verifyOtp("01012345678", "0000")

        assertEquals(ApiError.SERVER, (outcome as ApiOutcome.Failure).error)
    }

    @Test
    fun `no connectivity surfaces as a network error, not a failure of the code`() = runTest {
        server.shutdown() // nothing is listening

        val outcome = devices.requestOtp("01012345678")

        assertEquals(ApiError.NETWORK, (outcome as ApiOutcome.Failure).error)
    }

    @Test
    fun `rules fetch failing does not undo a successful verification`() = runTest {
        server.enqueue(
            json("""{"accessToken":"a","refreshToken":"r","deviceId":"d","phone":"+201012345678"}"""),
        )
        server.enqueue(MockResponse().setResponseCode(500)) // rules fetch fails

        val outcome = devices.verifyOtp("01012345678", "0000")

        assertTrue(outcome is ApiOutcome.Success)
        assertTrue(devices.isRegistered())
    }

    private fun json(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
