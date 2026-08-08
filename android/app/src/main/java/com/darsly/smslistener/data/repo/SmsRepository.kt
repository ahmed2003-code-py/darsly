package com.darsly.smslistener.data.repo

import com.darsly.smslistener.data.local.SenderRuleDao
import com.darsly.smslistener.data.local.SenderRuleEntity
import com.darsly.smslistener.data.local.SmsMessageDao
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.data.local.SyncStatus
import com.darsly.smslistener.data.remote.DeviceApi
import com.darsly.smslistener.data.remote.SenderRuleDto
import com.darsly.smslistener.data.remote.SmsEventRequest
import com.darsly.smslistener.domain.BootstrapRules
import com.darsly.smslistener.domain.MessageHasher
import com.darsly.smslistener.domain.SenderClassifier
import com.darsly.smslistener.domain.SenderMatchType
import com.darsly.smslistener.domain.SenderRule
import com.darsly.smslistener.domain.SyncDecision
import com.darsly.smslistener.domain.SyncPolicy
import com.darsly.smslistener.sms.ReceivedSms
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import retrofit2.HttpException

/** Whether the worker should be asked to run again. */
enum class SyncOutcome { DONE, RETRY }

/**
 * The outbox.
 *
 *     SMS received → Room (source of truth) → PENDING → SyncWorker → backend → SYNCED
 *
 * Two properties are load-bearing:
 *
 *  1. **Nothing is lost.** The network is never on the receive path. A message is
 *     durable the moment it is stored; connectivity, backend health, and token
 *     validity only affect *when* it is delivered, never *whether* it was kept.
 *  2. **Nothing is sent twice.** The row key is the deterministic message hash, so
 *     a duplicate platform delivery cannot insert; and the backend enforces
 *     `UNIQUE(deviceId, messageHash)`, so even a retry after an ambiguous timeout
 *     resolves to the same event.
 *
 * Deliberately free of Android types so the whole pipeline is testable on the JVM.
 */
class SmsRepository(
    private val messages: SmsMessageDao,
    private val rules: SenderRuleDao,
    private val api: DeviceApi,
    private val onForwardableMessage: (brand: String, body: String) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
) {

    fun observeRecent(limit: Int = 200): Flow<List<SmsMessageEntity>> = messages.observeRecent(limit)

    fun observeUnsyncedCount(): Flow<Int> = messages.observeUnsyncedCount()

    /**
     * Store an incoming SMS and, if a rule says it is payment-relevant, queue it.
     * Returns true when it was newly queued for upload.
     */
    suspend fun onSmsReceived(sms: ReceivedSms): Boolean {
        val hash = MessageHasher.hash(sms.sender, sms.body, sms.receivedAtMillis)
        val classification = SenderClassifier.classify(sms.sender, effectiveRules())
        val forward = classification?.forwardToBackend == true

        val inserted = messages.insertIfNew(
            SmsMessageEntity(
                messageHash = hash,
                sender = sms.sender,
                body = sms.body,
                receivedAt = sms.receivedAtMillis,
                simSlot = sms.simSlot,
                subscriptionId = sms.subscriptionId,
                brand = classification?.brand,
                syncStatus = if (forward) SyncStatus.PENDING else SyncStatus.LOCAL_ONLY,
            ),
        )
        // -1 means the hash was already stored: the platform re-delivered a message
        // we have already handled. Do not re-queue and do not notify again.
        if (inserted == -1L) return false

        if (forward && classification != null) {
            onForwardableMessage(classification.brand, sms.body)
        }
        return forward
    }

    /**
     * Upload one batch of pending events.
     *
     * Each entry is settled independently: one poisoned payload cannot stall the
     * queue behind it, and one transient failure does not mark the others failed.
     */
    suspend fun syncPending(batchSize: Int = 50): SyncOutcome {
        val batch = messages.pending(batchSize)
        if (batch.isEmpty()) return SyncOutcome.DONE

        var retryNeeded = false
        for (message in batch) {
            val attemptedAt = now()
            val decision = upload(message)

            when (decision) {
                SyncDecision.SUCCESS -> Unit // already recorded inside upload()

                SyncDecision.RETRY, SyncDecision.UNAUTHORIZED -> {
                    retryNeeded = true
                    // Park the entry only after a lot of failed attempts — and even
                    // then it is kept, not deleted, and "Sync now" can revive it.
                    val exhausted = SyncPolicy.exhausted(message.attemptCount + 1)
                    messages.recordAttempt(
                        messageHash = message.messageHash,
                        status = if (exhausted) SyncStatus.FAILED else SyncStatus.PENDING,
                        serverStatus = null,
                        attemptedAt = attemptedAt,
                        error = decision.name,
                    )
                }

                SyncDecision.PERMANENT_FAILURE -> messages.recordAttempt(
                    messageHash = message.messageHash,
                    status = SyncStatus.FAILED,
                    serverStatus = null,
                    attemptedAt = attemptedAt,
                    error = decision.name,
                )
            }
        }
        return if (retryNeeded) SyncOutcome.RETRY else SyncOutcome.DONE
    }

    private suspend fun upload(message: SmsMessageEntity): SyncDecision =
        try {
            val response = api.postSmsEvent(
                SmsEventRequest(
                    sender = message.sender,
                    message = message.body,
                    receivedAt = Instant.ofEpochMilli(message.receivedAt).toString(),
                    messageHash = message.messageHash,
                    simSlot = message.simSlot,
                    subscriptionId = message.subscriptionId,
                ),
            )
            messages.recordAttempt(
                messageHash = message.messageHash,
                // A `duplicate: true` response is a success: the backend already
                // has this event, which is exactly the outcome we wanted.
                status = SyncStatus.SYNCED,
                serverStatus = response.status,
                attemptedAt = now(),
                error = null,
            )
            SyncDecision.SUCCESS
        } catch (e: HttpException) {
            SyncPolicy.forHttpStatus(e.code())
        } catch (_: IOException) {
            SyncPolicy.forNetworkError()
        } catch (_: Exception) {
            SyncPolicy.forNetworkError()
        }

    /** Manual retry from Settings — revive parked entries. */
    suspend fun requeueFailed() = messages.requeueFailed()

    suspend fun deleteAllMessages() = messages.deleteAll()

    // ── Sender rules ─────────────────────────────────────────────────────────

    /**
     * Pull the backend rule set and replace the local cache atomically, then
     * re-check anything that was previously unclassified.
     */
    suspend fun refreshRules(): ApiOutcome<Int> {
        val outcome = apiCall {
            val fetched = api.smsRules()
            if (fetched.isNotEmpty()) {
                rules.replaceAll(fetched.map { it.toEntity() })
            }
            fetched.size
        }
        if (outcome is ApiOutcome.Success) reclassifyLocalOnly()
        return outcome
    }

    /**
     * Re-run classification over messages that matched no rule when they arrived.
     *
     * Without this, a payment SMS received before its sender rule existed — or
     * before a matching bug was fixed — would sit on the phone forever, because
     * classification only ever ran once at receive time. Anything that now
     * matches a forwarding rule is promoted into the outbox and picked up by the
     * next sync. Idempotency makes a re-send harmless.
     *
     * Returns how many messages were promoted.
     */
    suspend fun reclassifyLocalOnly(limit: Int = 200): Int {
        val candidates = messages.localOnly(limit)
        if (candidates.isEmpty()) return 0

        val current = effectiveRules()
        var promoted = 0
        for (message in candidates) {
            val classification = SenderClassifier.classify(message.sender, current) ?: continue
            if (!classification.forwardToBackend) continue
            messages.promoteToPending(message.messageHash, classification.brand)
            promoted++
        }
        return promoted
    }

    /**
     * The rules to classify with. Falls back to the bootstrap set while the cache
     * is still empty (fresh install, first SMS before the first rules sync) so a
     * payment message arriving in that window is still recognised.
     */
    suspend fun effectiveRules(): List<SenderRule> {
        val cached = rules.all()
        return if (cached.isEmpty()) BootstrapRules.DEFAULTS else cached.map { it.toDomain() }
    }
}

private fun SenderRuleDto.toEntity() = SenderRuleEntity(
    brand = brand,
    matchType = runCatching { SenderMatchType.valueOf(matchType.uppercase()) }
        .getOrDefault(SenderMatchType.CONTAINS),
    pattern = pattern,
    provider = provider,
    enabled = enabled,
    forwardToBackend = forwardToBackend,
    priority = priority,
)

private fun SenderRuleEntity.toDomain() = SenderRule(
    brand = brand,
    matchType = matchType,
    pattern = pattern,
    provider = provider,
    enabled = enabled,
    forwardToBackend = forwardToBackend,
    priority = priority,
)
