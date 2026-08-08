package com.darsly.smslistener.testing

import com.darsly.smslistener.data.local.SenderRuleDao
import com.darsly.smslistener.data.local.SenderRuleEntity
import com.darsly.smslistener.data.local.SmsMessageDao
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.data.local.SyncStatus
import com.darsly.smslistener.data.security.DeviceSession
import com.darsly.smslistener.data.security.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map

/**
 * In-memory doubles for the storage layer, so the repository, retry policy and
 * dedupe behaviour can be tested as plain JVM code — no emulator, no Room.
 * They implement the same DAO interfaces the production code depends on.
 */
class FakeSmsMessageDao : SmsMessageDao {

    private val rows = LinkedHashMap<String, SmsMessageEntity>()
    private val revision = MutableStateFlow(0)

    val all: List<SmsMessageEntity> get() = rows.values.toList()

    fun get(messageHash: String): SmsMessageEntity? = rows[messageHash]

    override suspend fun insertIfNew(message: SmsMessageEntity): Long {
        if (rows.containsKey(message.messageHash)) return -1L
        rows[message.messageHash] = message
        revision.value++
        return rows.size.toLong()
    }

    override fun observeRecent(limit: Int): Flow<List<SmsMessageEntity>> =
        revision.map { rows.values.sortedByDescending { row -> row.receivedAt }.take(limit) }

    override suspend fun pending(limit: Int): List<SmsMessageEntity> =
        rows.values
            .filter { it.syncStatus == SyncStatus.PENDING }
            .sortedBy { it.receivedAt }
            .take(limit)

    override fun observeUnsyncedCount(): Flow<Int> = revision.map {
        rows.values.count { row ->
            row.syncStatus == SyncStatus.PENDING || row.syncStatus == SyncStatus.FAILED
        }
    }

    override suspend fun find(messageHash: String): SmsMessageEntity? = rows[messageHash]

    override suspend fun recordAttempt(
        messageHash: String,
        status: SyncStatus,
        serverStatus: String?,
        attemptedAt: Long,
        error: String?,
    ) {
        val existing = rows[messageHash] ?: return
        rows[messageHash] = existing.copy(
            syncStatus = status,
            serverStatus = serverStatus,
            attemptCount = existing.attemptCount + 1,
            lastAttemptAt = attemptedAt,
            lastError = error,
        )
        revision.value++
    }

    override suspend fun localOnly(limit: Int): List<SmsMessageEntity> =
        rows.values
            .filter { it.syncStatus == SyncStatus.LOCAL_ONLY }
            .sortedByDescending { it.receivedAt }
            .take(limit)

    override suspend fun promoteToPending(messageHash: String, brand: String?) {
        val existing = rows[messageHash] ?: return
        if (existing.syncStatus != SyncStatus.LOCAL_ONLY) return
        rows[messageHash] = existing.copy(
            syncStatus = SyncStatus.PENDING,
            brand = brand,
            attemptCount = 0,
            lastError = null,
        )
        revision.value++
    }

    override suspend fun requeueFailed() {
        rows.entries
            .filter { it.value.syncStatus == SyncStatus.FAILED }
            .forEach { (key, value) ->
                rows[key] = value.copy(
                    syncStatus = SyncStatus.PENDING,
                    attemptCount = 0,
                    lastError = null,
                )
            }
        revision.value++
    }

    override suspend fun deleteAll() {
        rows.clear()
        revision.value++
    }
}

class FakeSenderRuleDao : SenderRuleDao {

    private val rows = mutableListOf<SenderRuleEntity>()

    override suspend fun all(): List<SenderRuleEntity> = rows.sortedBy { it.priority }

    override suspend fun count(): Int = rows.size

    override suspend fun insertAll(rules: List<SenderRuleEntity>) {
        rows.addAll(rules)
    }

    override suspend fun deleteAll() {
        rows.clear()
    }
}

class FakeSessionStore(initial: DeviceSession? = null) : SessionStore {

    private var current: DeviceSession? = initial
    private val _registered = MutableStateFlow(initial != null)

    var cleared = false
        private set

    override val registered: StateFlow<Boolean> = _registered

    override fun session(): DeviceSession? = current

    override fun accessToken(): String? = current?.accessToken

    override fun refreshToken(): String? = current?.refreshToken

    override fun deviceId(): String? = current?.deviceId

    override fun phone(): String? = current?.phone

    override fun save(session: DeviceSession) {
        current = session
        _registered.value = true
    }

    override fun updateTokens(accessToken: String, refreshToken: String) {
        current = current?.copy(accessToken = accessToken, refreshToken = refreshToken)
    }

    override fun clear() {
        current = null
        cleared = true
        _registered.value = false
    }
}
