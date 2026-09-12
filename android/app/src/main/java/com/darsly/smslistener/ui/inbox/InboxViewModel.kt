package com.darsly.smslistener.ui.inbox

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.di.ServiceLocator
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/**
 * What the top of the inbox reports about the link to the backend.
 *
 * Nothing here costs a network call: the phone already knows whether it is
 * enrolled, how much is waiting to go out, and when the backend last
 * acknowledged something. That is enough to tell the three states apart
 * without polling a server that may not be reachable anyway.
 */
enum class LinkState {
    /** No device session — the app has never been enrolled, or was revoked. */
    NOT_ENROLLED,

    /** Enrolled, and everything received has been acknowledged. */
    CONNECTED,

    /** Enrolled, but messages are queued or retrying. */
    PENDING,
}

data class InboxUiState(
    val messages: List<SmsMessageEntity> = emptyList(),
    val link: LinkState = LinkState.NOT_ENROLLED,
    val unsyncedCount: Int = 0,
    val lastSyncedAt: Long? = null,
    val phone: String? = null,
)

class InboxViewModel(application: Application) : AndroidViewModel(application) {

    private val locator = ServiceLocator.from(application)
    private val messages = locator.smsRepository
    private val session = locator.sessionStore

    /**
     * Straight from Room, so the list updates the moment a broadcast is stored or
     * the sync worker changes a status — no manual refresh anywhere.
     */
    val state: StateFlow<InboxUiState> = combine(
        messages.observeRecent(),
        messages.observeUnsyncedCount(),
        messages.observeLastSyncedAt(),
        session.registered,
    ) { list, unsynced, lastSynced, registered ->
        InboxUiState(
            messages = list,
            link = when {
                !registered -> LinkState.NOT_ENROLLED
                unsynced > 0 -> LinkState.PENDING
                else -> LinkState.CONNECTED
            },
            unsyncedCount = unsynced,
            lastSyncedAt = lastSynced,
            phone = session.phone(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), InboxUiState())
}
