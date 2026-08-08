package com.darsly.smslistener.ui.settings

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.darsly.smslistener.data.repo.ApiOutcome
import com.darsly.smslistener.di.ServiceLocator
import com.darsly.smslistener.work.WorkScheduler
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class BackendStatus { UNKNOWN, CHECKING, CONNECTED, UNREACHABLE }

class SettingsViewModel(application: Application) : AndroidViewModel(application) {

    private val locator = ServiceLocator.from(application)
    private val devices = locator.deviceRepository
    private val messages = locator.smsRepository
    private val settings = locator.settingsStore

    val verifiedPhone: String? get() = devices.verifiedPhone()

    val unsyncedCount: StateFlow<Int> = messages.observeUnsyncedCount()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0)

    val notificationPreview: StateFlow<Boolean> = settings.notificationPreview

    private val _backendStatus = MutableStateFlow(BackendStatus.UNKNOWN)
    val backendStatus: StateFlow<BackendStatus> = _backendStatus.asStateFlow()

    fun smsPermissionGranted(): Boolean =
        ContextCompat.checkSelfPermission(
            getApplication(),
            Manifest.permission.RECEIVE_SMS,
        ) == PackageManager.PERMISSION_GRANTED

    /** Uses the heartbeat endpoint, so "connected" means authenticated too. */
    fun checkBackend() {
        _backendStatus.value = BackendStatus.CHECKING
        viewModelScope.launch {
            _backendStatus.value = when (devices.heartbeat()) {
                is ApiOutcome.Success -> BackendStatus.CONNECTED
                is ApiOutcome.Failure -> BackendStatus.UNREACHABLE
            }
        }
    }

    fun setNotificationPreview(enabled: Boolean) = settings.setNotificationPreview(enabled)

    /** Revive parked entries, re-pull the rules, and kick the worker. */
    fun syncNow() {
        viewModelScope.launch {
            messages.requeueFailed()
            WorkScheduler.refreshAndSyncNow(getApplication())
        }
    }

    fun deleteLocalMessages() {
        viewModelScope.launch { devices.deleteLocalMessages() }
    }

    /**
     * Secure logout: revoke server-side, wipe locally, and stop background work.
     * Routing back to verification happens on its own when the session clears.
     */
    fun unregister() {
        viewModelScope.launch {
            devices.unregister()
            WorkScheduler.cancelAll(getApplication())
        }
    }
}
