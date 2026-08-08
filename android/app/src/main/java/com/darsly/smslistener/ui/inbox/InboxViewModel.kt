package com.darsly.smslistener.ui.inbox

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.darsly.smslistener.data.local.SmsMessageEntity
import com.darsly.smslistener.di.ServiceLocator
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

class InboxViewModel(application: Application) : AndroidViewModel(application) {

    private val messages = ServiceLocator.from(application).smsRepository

    /**
     * Straight from Room, so the list updates the moment a broadcast is stored or
     * the sync worker changes a status — no manual refresh anywhere.
     */
    val items: StateFlow<List<SmsMessageEntity>> = messages.observeRecent()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}
