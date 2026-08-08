package com.darsly.smslistener.domain

/**
 * Pure sender classification — a deliberate mirror of the backend's
 * `sms-parser.ts` so the phone and the server reach the same verdict.
 *
 * The phone's verdict decides only whether a message is *queued for upload*; the
 * server re-derives classification (and every money-affecting field) from the raw
 * body before anything can be auto-verified. A wrong local verdict can therefore
 * never move money — at worst it withholds a message, which the user can see in
 * the inbox.
 */
object SenderClassifier {

    private val WHITESPACE = Regex("\\s+")
    private val NON_ALPHANUMERIC = Regex("[^\\p{L}\\p{N}]")

    /**
     * Sender ids arrive in many shapes — `CIB`, `CIB-Bank`, `VodafoneCash`, numeric
     * short codes — so matching is done on a trimmed, whitespace-collapsed,
     * lower-cased form rather than on the raw value.
     */
    fun normalizeSender(sender: String?): String =
        (sender ?: "").trim().replace(WHITESPACE, " ").lowercase()

    /**
     * Returns the first matching enabled rule in ascending [SenderRule.priority]
     * (lower wins), or `null` when nothing matches — unknown senders stay local.
     */
    fun classify(sender: String?, rules: List<SenderRule>): Classification? {
        val normalized = normalizeSender(sender)
        return rules
            .filter { it.enabled }
            .sortedBy { it.priority }
            .firstOrNull { matches(normalized, it) }
            ?.let { Classification(it.brand, it.provider, it.forwardToBackend) }
    }

    /**
     * Collapse a sender id to the characters that actually identify it: letters
     * and digits, nothing else.
     *
     * Real sender ids spell the same brand every which way — `VF-Cash`,
     * `VF Cash`, `VFCash`, `CIB-Bank`. Matching raw text means a rule written as
     * `vfcash` silently misses `VF-Cash`, and a payment SMS stays local-only.
     * Stripping separators lets one rule cover every spelling.
     *
     * Note this is used for *matching only* — never for hashing. The message
     * hash keeps using [normalizeSender], so changing this can never break
     * idempotency against already-delivered events.
     */
    fun matchKey(value: String?): String =
        normalizeSender(value).replace(NON_ALPHANUMERIC, "")

    private fun matches(normalizedSender: String, rule: SenderRule): Boolean =
        when (rule.matchType) {
            SenderMatchType.EXACT -> matchKey(normalizedSender) == matchKey(rule.pattern)
            SenderMatchType.CONTAINS -> {
                val pattern = matchKey(rule.pattern)
                pattern.isNotEmpty() && matchKey(normalizedSender).contains(pattern)
            }
            // A malformed pattern pushed from the backend must never crash the
            // receiver — an invalid regex is simply "no match".
            SenderMatchType.REGEX -> runCatching {
                Regex(rule.pattern, RegexOption.IGNORE_CASE).containsMatchIn(normalizedSender)
            }.getOrDefault(false)
        }
}
