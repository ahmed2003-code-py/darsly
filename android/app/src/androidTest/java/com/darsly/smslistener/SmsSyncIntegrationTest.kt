package com.darsly.smslistener

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.darsly.smslistener.data.local.AppDatabase
import com.darsly.smslistener.data.local.SyncStatus
import com.darsly.smslistener.data.remote.ApiClient
import com.darsly.smslistener.data.repo.SmsRepository
import com.darsly.smslistener.data.repo.SyncOutcome
import com.darsly.smslistener.data.security.DeviceSession
import com.darsly.smslistener.data.security.SessionStore
import com.darsly.smslistener.domain.MessageHasher
import com.darsly.smslistener.sms.ReceivedSms
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The same outbox guarantees, but against a **real Room database** rather than a
 * fake DAO — this is what proves the `UNIQUE` primary key on the message hash
 * actually suppresses duplicates at the storage layer, and that a message written
 * before connectivity existed is still there afterwards.
 */
@RunWith(AndroidJUnit4::class)
class SmsSyncIntegrationTest {

    private lateinit var database: AppDatabase
    private lateinit var server: MockWebServer
    private lateinit var repository: SmsRepository

    private val cibSms = ReceivedSms(
        sender = "CIB",
        body = "Your account was credited with EGP 5,000. Ref 884213",
        receivedAtMillis = 1_754_632_320_000,
        subscriptionId = 3,
        simSlot = 1,
    )
    private val hash get() = MessageHasher.hash(cibSms.sender, cibSms.body, cibSms.receivedAtMillis)

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer()
        server.start()
        repository = newRepository()
    }

    @After
    fun tearDown() {
        database.close()
        runCatching { server.shutdown() }
    }

    private fun newRepository(): SmsRepository {
        val session = InMemorySessionStore(
            DeviceSession("access", "refresh", "dev-1", "+201012345678"),
        )
        return SmsRepository(
            messages = database.smsMessages(),
            rules = database.senderRules(),
            api = ApiClient.create(server.url("/api/v1/").toString(), session),
        )
    }

    @Test
    fun offlineMessageSurvivesAndSyncsWhenTheBackendReturns() = runBlocking {
        // 1. SMS arrives with no connectivity.
        server.shutdown()
        repository.onSmsReceived(cibSms)
        assertEquals(SyncStatus.PENDING, database.smsMessages().find(hash)?.syncStatus)

        assertEquals(SyncOutcome.RETRY, repository.syncPending())
        assertEquals(SyncStatus.PENDING, database.smsMessages().find(hash)?.syncStatus)

        // 2. Connectivity returns — the stored message is delivered.
        server = MockWebServer()
        server.start()
        repository = newRepository()
        server.enqueue(jsonResponse("""{"eventId":"evt-1","duplicate":false,"status":"MATCHED"}"""))

        assertEquals(SyncOutcome.DONE, repository.syncPending())

        val stored = database.smsMessages().find(hash)
        assertNotNull(stored)
        assertEquals(SyncStatus.SYNCED, stored?.syncStatus)
        assertEquals("MATCHED", stored?.serverStatus)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun duplicateDeliveryIsRejectedByThePrimaryKey() = runBlocking {
        repository.onSmsReceived(cibSms)
        repository.onSmsReceived(cibSms)
        repository.onSmsReceived(cibSms)

        assertEquals(1, database.smsMessages().pending(50).size)

        server.enqueue(jsonResponse("""{"eventId":"evt-1","status":"MATCHED"}"""))
        repository.syncPending()

        assertEquals(1, server.requestCount)
        assertEquals(0, database.smsMessages().pending(50).size)
    }

    @Test
    fun unknownSendersAreStoredButNeverUploaded() = runBlocking {
        repository.onSmsReceived(cibSms.copy(sender = "+201009998877", body = "See you at 8"))

        assertEquals(0, database.smsMessages().pending(50).size)
        repository.syncPending()
        assertEquals(0, server.requestCount)
    }

    @Test
    fun ruleRefreshReplacesTheCacheAtomically() = runBlocking {
        server.enqueue(
            jsonResponse(
                """[{"brand":"QNB","matchType":"CONTAINS","pattern":"qnb","provider":"BANK_TRANSFER","enabled":true,"forwardToBackend":true,"priority":5}]""",
            ),
        )
        repository.refreshRules()

        val rules = repository.effectiveRules()
        assertEquals(1, rules.size)
        assertEquals("QNB", rules.first().brand)
    }

    private fun jsonResponse(body: String) = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)
}

private class InMemorySessionStore(private var current: DeviceSession?) : SessionStore {
    private val _registered = MutableStateFlow(current != null)
    override val registered: StateFlow<Boolean> = _registered
    override fun session() = current
    override fun accessToken() = current?.accessToken
    override fun refreshToken() = current?.refreshToken
    override fun deviceId() = current?.deviceId
    override fun phone() = current?.phone
    override fun save(session: DeviceSession) {
        current = session
        _registered.value = true
    }
    override fun updateTokens(accessToken: String, refreshToken: String) {
        current = current?.copy(accessToken = accessToken, refreshToken = refreshToken)
    }
    override fun clear() {
        current = null
        _registered.value = false
    }
}
