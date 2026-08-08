package com.darsly.smslistener.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.darsly.smslistener.domain.SenderMatchType

/** Lifecycle of one message in the outbox. */
enum class SyncStatus {
    /** No rule matched — kept on the phone, never sent anywhere. */
    LOCAL_ONLY,

    /** Matched a forwarding rule; waiting for (or retrying) upload. */
    PENDING,

    /** The backend acknowledged it (new or idempotent duplicate). */
    SYNCED,

    /** Rejected in a way retrying cannot fix, or retries exhausted. Still stored. */
    FAILED,
}

/**
 * A received SMS. This table *is* the outbox — the local store is the source of
 * truth and the network is never on the receive path, so a message survives no
 * connectivity, a backend outage, or the app being killed mid-upload.
 *
 * The primary key is the deterministic [com.darsly.smslistener.domain.MessageHasher]
 * digest, which makes duplicate suppression a property of the schema rather than
 * of any code path: a re-delivered broadcast simply fails to insert.
 */
@Entity(
    tableName = "sms_messages",
    indices = [Index("receivedAt"), Index("syncStatus")],
)
data class SmsMessageEntity(
    @PrimaryKey val messageHash: String,
    val sender: String,
    val body: String,
    /** Epoch millis, from the message's own timestamp (not time-of-processing). */
    val receivedAt: Long,
    val simSlot: Int? = null,
    val subscriptionId: Int? = null,
    /** Brand from the matched rule, e.g. "CIB". Null when unclassified. */
    val brand: String? = null,
    val syncStatus: SyncStatus = SyncStatus.LOCAL_ONLY,
    val attemptCount: Int = 0,
    val lastAttemptAt: Long? = null,
    /** Short failure reason for the UI. Never contains message content. */
    val lastError: String? = null,
    /** The backend's verdict: MATCHED | UNMATCHED | AMBIGUOUS | DUPLICATE | LOCAL_ONLY. */
    val serverStatus: String? = null,
)

/** Locally cached copy of the backend's sender rules. */
@Entity(tableName = "sender_rules")
data class SenderRuleEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val brand: String,
    val matchType: SenderMatchType,
    val pattern: String,
    val provider: String,
    val enabled: Boolean,
    val forwardToBackend: Boolean,
    val priority: Int,
)
