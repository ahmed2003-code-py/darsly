package com.darsly.smslistener.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface SmsMessageDao {

    /**
     * Insert unless the hash is already present. Returns the new rowid, or -1 when
     * the message was already stored — the caller uses that to avoid re-queueing
     * or re-notifying for a duplicate platform delivery.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfNew(message: SmsMessageEntity): Long

    @Query("SELECT * FROM sms_messages ORDER BY receivedAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<SmsMessageEntity>>

    /** One batch of work for the sync worker, oldest first so ordering is preserved. */
    @Query("SELECT * FROM sms_messages WHERE syncStatus = 'PENDING' ORDER BY receivedAt ASC LIMIT :limit")
    suspend fun pending(limit: Int): List<SmsMessageEntity>

    @Query("SELECT COUNT(*) FROM sms_messages WHERE syncStatus IN ('PENDING', 'FAILED')")
    fun observeUnsyncedCount(): Flow<Int>

    @Query("SELECT * FROM sms_messages WHERE messageHash = :messageHash")
    suspend fun find(messageHash: String): SmsMessageEntity?

    @Query(
        """
        UPDATE sms_messages
           SET syncStatus = :status,
               serverStatus = :serverStatus,
               attemptCount = attemptCount + 1,
               lastAttemptAt = :attemptedAt,
               lastError = :error
         WHERE messageHash = :messageHash
        """,
    )
    suspend fun recordAttempt(
        messageHash: String,
        status: SyncStatus,
        serverStatus: String?,
        attemptedAt: Long,
        error: String?,
    )

    /**
     * Messages no rule matched when they arrived. Re-checked whenever the rule
     * set changes, so a sender the backend learns about later is still picked up
     * rather than being stranded on the phone.
     */
    @Query("SELECT * FROM sms_messages WHERE syncStatus = 'LOCAL_ONLY' ORDER BY receivedAt DESC LIMIT :limit")
    suspend fun localOnly(limit: Int): List<SmsMessageEntity>

    /** Promote a previously unclassified message into the outbox. */
    @Query("UPDATE sms_messages SET syncStatus = 'PENDING', brand = :brand, attemptCount = 0, lastError = NULL WHERE messageHash = :messageHash AND syncStatus = 'LOCAL_ONLY'")
    suspend fun promoteToPending(messageHash: String, brand: String?)

    /** Manual "sync now" — give parked entries one more chance. */
    @Query("UPDATE sms_messages SET syncStatus = 'PENDING', attemptCount = 0, lastError = NULL WHERE syncStatus = 'FAILED'")
    suspend fun requeueFailed()

    @Query("DELETE FROM sms_messages")
    suspend fun deleteAll()
}

@Dao
interface SenderRuleDao {

    @Query("SELECT * FROM sender_rules ORDER BY priority ASC")
    suspend fun all(): List<SenderRuleEntity>

    @Query("SELECT COUNT(*) FROM sender_rules")
    suspend fun count(): Int

    @Insert
    suspend fun insertAll(rules: List<SenderRuleEntity>)

    @Query("DELETE FROM sender_rules")
    suspend fun deleteAll()

    /**
     * Rules are replaced wholesale, in one transaction, so a device can never end
     * up applying a half-updated rule set (which could forward — or withhold — the
     * wrong senders).
     */
    @Transaction
    suspend fun replaceAll(rules: List<SenderRuleEntity>) {
        deleteAll()
        insertAll(rules)
    }
}
