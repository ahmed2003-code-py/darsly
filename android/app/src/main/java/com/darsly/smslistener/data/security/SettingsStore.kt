package com.darsly.smslistener.data.security

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Non-sensitive user preferences. Deliberately separate from [SessionStore] so
 * credentials and ordinary settings never share a file.
 */
class SettingsStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("darsly_listener_settings", Context.MODE_PRIVATE)

    private val _notificationPreview = MutableStateFlow(prefs.getBoolean(KEY_PREVIEW, false))

    /**
     * Whether a payment notification may show the message text. Off by default —
     * a transfer SMS on a lock screen is exactly the content a user would not want
     * shoulder-surfed.
     */
    val notificationPreview: StateFlow<Boolean> = _notificationPreview.asStateFlow()

    fun setNotificationPreview(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_PREVIEW, enabled).apply()
        _notificationPreview.value = enabled
    }

    fun notificationPreviewEnabled(): Boolean = _notificationPreview.value

    private companion object {
        const val KEY_PREVIEW = "notification_preview"
    }
}
