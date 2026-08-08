package com.darsly.smslistener.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.darsly.smslistener.R
import com.darsly.smslistener.data.security.SettingsStore
import com.darsly.smslistener.ui.MainActivity

/**
 * Local notifications for payment-relevant SMS only.
 *
 * Ordinary messages never notify — the phone's real SMS app already did that, and
 * a second notification for every message would be noise. By default the
 * notification names the sender brand and says a transfer message was handled; the
 * message text itself is shown only if the user turns previews on in Settings.
 */
class Notifier(
    private val context: Context,
    private val settings: SettingsStore,
) {

    // The POST_NOTIFICATIONS check lives in canNotify(); lint cannot see through it.
    @SuppressLint("MissingPermission")
    fun paymentSmsDetected(brand: String, body: String) {
        if (!canNotify()) return
        ensureChannel()

        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val text = if (settings.notificationPreviewEnabled()) {
            body
        } else {
            context.getString(R.string.notif_body_hidden)
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notif_title, brand))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            // Even with previews enabled, keep financial text off the lock screen.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(context.getString(R.string.notif_title, brand))
                    .setContentText(context.getString(R.string.notif_body_hidden))
                    .build(),
            )
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(nextId(), notification)
        }
    }

    private fun canNotify(): Boolean {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        // POST_NOTIFICATIONS is only enforced from API 33; below that it is
        // implicitly granted.
        val required = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
        return !required || granted
    }

    private fun ensureChannel() {
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.notif_channel_desc)
                setShowBadge(false)
            },
        )
    }

    private fun nextId(): Int = (System.currentTimeMillis() % Int.MAX_VALUE).toInt()

    private companion object {
        const val CHANNEL_ID = "payment_sms"
    }
}
