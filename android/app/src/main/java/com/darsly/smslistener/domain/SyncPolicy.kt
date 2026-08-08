package com.darsly.smslistener.domain

/** What to do with one outbox entry after an upload attempt. */
enum class SyncDecision {
    /** Accepted by the backend (including an idempotent duplicate) — done. */
    SUCCESS,

    /** Transient: keep the entry pending and try again with backoff. */
    RETRY,

    /** The backend will never accept this payload; stop burning battery on it. */
    PERMANENT_FAILURE,

    /**
     * Credentials are the problem, not the payload. Keep the entry pending — the
     * OkHttp authenticator refreshes the device token, and if the device has been
     * revoked server-side the user is returned to verification.
     */
    UNAUTHORIZED,
}

/**
 * Pure retry classification, kept out of the worker so it is directly testable.
 * The guiding rule: *never* drop an event for a reason that might be temporary.
 */
object SyncPolicy {

    /** Attempts after which an entry is parked as failed rather than retried forever. */
    const val MAX_ATTEMPTS = 25

    fun forHttpStatus(code: Int): SyncDecision = when {
        code in 200..299 -> SyncDecision.SUCCESS
        code == 401 || code == 403 -> SyncDecision.UNAUTHORIZED
        // 408 request timeout, 429 rate limited — explicitly retryable 4xx.
        code == 408 || code == 429 -> SyncDecision.RETRY
        // Any other 4xx is our bug (bad payload); retrying cannot fix it.
        code in 400..499 -> SyncDecision.PERMANENT_FAILURE
        code >= 500 -> SyncDecision.RETRY
        else -> SyncDecision.RETRY
    }

    /** No connectivity, DNS failure, socket timeout, TLS reset… always retryable. */
    fun forNetworkError(): SyncDecision = SyncDecision.RETRY

    fun exhausted(attemptCount: Int): Boolean = attemptCount >= MAX_ATTEMPTS
}
