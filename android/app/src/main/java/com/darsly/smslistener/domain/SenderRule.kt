package com.darsly.smslistener.domain

/** How a rule's [SenderRule.pattern] is matched against an SMS sender id. */
enum class SenderMatchType { EXACT, CONTAINS, REGEX }

/**
 * A backend-driven sender classification rule (`GET /device/sms-rules`).
 *
 * Business logic deliberately does not live in the APK: which senders exist, what
 * brand/provider they map to, and whether they are forwarded are all decided by
 * the server and cached locally. The only thing shipped in the app is the
 * *bootstrap* set in [BootstrapRules], used until the first successful rules sync
 * so that an SMS arriving on a freshly installed device is not misclassified.
 */
data class SenderRule(
    val brand: String,
    val matchType: SenderMatchType,
    val pattern: String,
    val provider: String,
    val enabled: Boolean = true,
    val forwardToBackend: Boolean = true,
    val priority: Int = 100,
)

/** The outcome of matching a sender against the rule set. */
data class Classification(
    val brand: String,
    val provider: String,
    val forwardToBackend: Boolean,
)

/**
 * Minimal bootstrap rules, identical to the backend's defaults. Replaced wholesale
 * by `GET /device/sms-rules` on the first successful sync.
 */
object BootstrapRules {
    val DEFAULTS: List<SenderRule> = listOf(
        SenderRule("CIB", SenderMatchType.CONTAINS, "cib", "BANK_TRANSFER", priority = 10),
        SenderRule("Vodafone Cash", SenderMatchType.CONTAINS, "vodafone", "VODAFONE_CASH", priority = 20),
        SenderRule("Vodafone Cash", SenderMatchType.CONTAINS, "vfcash", "VODAFONE_CASH", priority = 21),
        SenderRule("InstaPay", SenderMatchType.CONTAINS, "instapay", "INSTAPAY", priority = 30),
    )
}
