package com.darsly.smslistener.data

import com.darsly.smslistener.data.local.SyncStatus
import com.darsly.smslistener.data.remote.ApiClient
import com.darsly.smslistener.data.repo.SmsRepository
import com.darsly.smslistener.data.repo.SyncOutcome
import com.darsly.smslistener.data.security.DeviceSession
import com.darsly.smslistener.domain.MessageHasher
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The outbox contract, end to end against a stubbed backend:
 * nothing is lost, nothing is sent twice, and a failure never discards a message.
 */
class SmsOutboxTest {

    private lateinit var server: MockWebServer
    private lateinit var messages: FakeSmsMessageDao
    private lateinit var rules: FakeSenderRuleDao
    private lateinit var repository: SmsRepository

    private val cibSms = ReceivedSms(
        sender = "CIB",
        body = "Your account was credited with EGP 5,000. Ref 884213",
        receivedAtMillis = 1_754_632_320_000,
        subscriptionId = 3,
        simSlot = 1,
    )

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        messages = FakeSmsMessageDao()
        rules = FakeSenderRuleDao()
        val session = FakeSessionStore(DeviceSession("access", "refresh", "dev-1", "+201012345678"))
        val api = ApiClient.create(server.url("/api/v1/").toString(), session)
        repository = SmsRepository(messages, rules, api)
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    @Test
    fun `a configured sender is stored pending and uploaded`() = runTest {
        assertTrue(repository.onSmsReceived(cibSms))
        val hash = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)
        assertEquals(SyncStatus.PENDING, messages.get(hash)?.syncStatus)
        assertEquals("CIB", messages.get(hash)?.brand)

        server.enqueue(json("""{"eventId":"evt-1","duplicate":false,"forwarded":true,"status":"MATCHED"}"""))
        assertEquals(SyncOutcome.DONE, repository.syncPending())

        assertEquals(SyncStatus.SYNCED, messages.get(hash)?.syncStatus)
        assertEquals("MATCHED", messages.get(hash)?.serverStatus)

        val request = server.takeRequest()
        assertEquals("/api/v1/device/sms-events", request.path)
        assertEquals("Bearer access", request.getHeader("Authorization"))
        val body = request.body.readUtf8()
        assertTrue(body.contains(hash))
        // Dual-SIM metadata travels with the event.
        assertTrue(body.contains("\"simSlot\":1"))
        assertTrue(body.contains("\"subscriptionId\":3"))
        // ISO-8601 UTC, as the API contract requires.
        assertTrue(body.contains("\"receivedAt\":\"2025-08-08T05:52:00Z\""))
    }

    @Test
    fun `an unknown sender is kept locally and never uploaded`() = runTest {
        val personal = cibSms.copy(sender = "+201009998877", body = "See you at 8")
        assertFalse(repository.onSmsReceived(personal))

        val hash = MessageHasher.hash(personal.sender, personal.body, personal.receivedAtMillis)
        assertEquals(SyncStatus.LOCAL_ONLY, messages.get(hash)?.syncStatus)

        assertEquals(SyncOutcome.DONE, repository.syncPending())
        assertEquals(0, server.requestCount) // the message never left the phone
    }

    @Test
    fun `a redelivered message is not stored or uploaded twice`() = runTest {
        assertTrue(repository.onSmsReceived(cibSms))
        // The platform delivers the identical broadcast again.
        assertFalse(repository.onSmsReceived(cibSms))

        assertEquals(1, messages.all.size)

        server.enqueue(json("""{"eventId":"evt-1","status":"MATCHED"}"""))
        repository.syncPending()
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `with no connectivity the message stays pending and is delivered later`() = runTest {
        repository.onSmsReceived(cibSms)
        val hash = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)

        server.shutdown() // backend unreachable
        assertEquals(SyncOutcome.RETRY, repository.syncPending())
        assertEquals(SyncStatus.PENDING, messages.get(hash)?.syncStatus)
        assertEquals(1, messages.get(hash)?.attemptCount)

        // Connectivity returns.
        server = MockWebServer()
        server.start()
        val session = FakeSessionStore(DeviceSession("access", "refresh", "dev-1", null))
        repository = SmsRepository(
            messages,
            rules,
            ApiClient.create(server.url("/api/v1/").toString(), session),
        )
        server.enqueue(json("""{"eventId":"evt-1","status":"MATCHED"}"""))

        assertEquals(SyncOutcome.DONE, repository.syncPending())
        assertEquals(SyncStatus.SYNCED, messages.get(hash)?.syncStatus)
    }

    @Test
    fun `a 500 keeps the message pending for another attempt`() = runTest {
        repository.onSmsReceived(cibSms)
        val hash = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)

        server.enqueue(MockResponse().setResponseCode(500))
        assertEquals(SyncOutcome.RETRY, repository.syncPending())
        assertEquals(SyncStatus.PENDING, messages.get(hash)?.syncStatus)

        server.enqueue(json("""{"eventId":"evt-1","status":"UNMATCHED"}"""))
        assertEquals(SyncOutcome.DONE, repository.syncPending())
        assertEquals(SyncStatus.SYNCED, messages.get(hash)?.syncStatus)
        assertEquals("UNMATCHED", messages.get(hash)?.serverStatus)
    }

    @Test
    fun `a rejected payload is parked as failed but never deleted`() = runTest {
        repository.onSmsReceived(cibSms)
        val hash = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)

        server.enqueue(MockResponse().setResponseCode(400))
        repository.syncPending()

        assertEquals(SyncStatus.FAILED, messages.get(hash)?.syncStatus)
        assertNotNull(messages.get(hash)) // still on the phone, visible in the inbox

        // "Sync now" gives it another chance.
        repository.requeueFailed()
        assertEquals(SyncStatus.PENDING, messages.get(hash)?.syncStatus)
    }

    @Test
    fun `the backend reporting a duplicate counts as delivered`() = runTest {
        repository.onSmsReceived(cibSms)
        val hash = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)

        // The first POST succeeded server-side but the response was lost; the retry
        // gets `duplicate: true`. That is success, not an error.
        server.enqueue(json("""{"eventId":"evt-1","duplicate":true,"status":"DUPLICATE"}"""))
        assertEquals(SyncOutcome.DONE, repository.syncPending())

        assertEquals(SyncStatus.SYNCED, messages.get(hash)?.syncStatus)
        assertEquals("DUPLICATE", messages.get(hash)?.serverStatus)
    }

    @Test
    fun `one poisoned message does not block the rest of the queue`() = runTest {
        repository.onSmsReceived(cibSms)
        repository.onSmsReceived(cibSms.copy(body = "Credited EGP 900", receivedAtMillis = 1_754_632_400_000))

        server.enqueue(MockResponse().setResponseCode(400)) // first rejected
        server.enqueue(json("""{"eventId":"evt-2","status":"MATCHED"}""")) // second fine
        repository.syncPending()

        val statuses = messages.all.map { it.syncStatus }.toSet()
        assertTrue(statuses.contains(SyncStatus.FAILED))
        assertTrue(statuses.contains(SyncStatus.SYNCED))
    }

    @Test
    fun `backend rules replace the bootstrap set`() = runTest {
        server.enqueue(
            json(
                """[{"brand":"QNB","matchType":"CONTAINS","pattern":"qnb","provider":"BANK_TRANSFER","enabled":true,"forwardToBackend":true,"priority":5}]""",
            ),
        )
        repository.refreshRules()

        val effective = repository.effectiveRules()
        assertEquals(1, effective.size)
        assertEquals("QNB", effective.first().brand)

        // A sender that only the bootstrap set knew about is now local-only.
        assertFalse(repository.onSmsReceived(cibSms))
        assertTrue(repository.onSmsReceived(cibSms.copy(sender = "QNB-ALAHLI")))
    }

    @Test
    fun `a message stranded as local-only is picked up when a rule starts matching`() = runTest {
        // Arrives while no rule matches "QNB-ALAHLI" — stays on the phone.
        val bankSms = cibSms.copy(sender = "QNB-ALAHLI", body = "Credited EGP 120")
        assertFalse(repository.onSmsReceived(bankSms))
        val hash = MessageHasher.hash(bankSms.sender, bankSms.body, bankSms.receivedAtMillis)
        assertEquals(SyncStatus.LOCAL_ONLY, messages.get(hash)?.syncStatus)

        // The backend learns about the sender.
        server.enqueue(
            json(
                """[{"brand":"QNB","matchType":"CONTAINS","pattern":"qnb","provider":"BANK_TRANSFER","enabled":true,"forwardToBackend":true,"priority":5}]""",
            ),
        )
        repository.refreshRules()

        // The stranded message is promoted rather than lost.
        assertEquals(SyncStatus.PENDING, messages.get(hash)?.syncStatus)
        assertEquals("QNB", messages.get(hash)?.brand)

        server.enqueue(json("""{"eventId":"evt-9","status":"UNMATCHED"}"""))
        assertEquals(SyncOutcome.DONE, repository.syncPending())
        assertEquals(SyncStatus.SYNCED, messages.get(hash)?.syncStatus)
    }

    @Test
    fun `reclassifying never promotes a genuinely unknown sender`() = runTest {
        val personal = cibSms.copy(sender = "+201009998877", body = "See you at 8")
        repository.onSmsReceived(personal)
        val hash = MessageHasher.hash(personal.sender, personal.body, personal.receivedAtMillis)

        assertEquals(0, repository.reclassifyLocalOnly())
        assertEquals(SyncStatus.LOCAL_ONLY, messages.get(hash)?.syncStatus)
    }

    private fun json(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}
