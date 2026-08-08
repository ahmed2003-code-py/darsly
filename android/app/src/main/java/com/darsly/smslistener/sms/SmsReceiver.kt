package com.darsly.smslistener.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import com.darsly.smslistener.di.ServiceLocator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/**
 * Receives incoming SMS.
 *
 * Declared in the manifest rather than registered at runtime, so it is delivered
 * even when the app process is not running — `SMS_RECEIVED` is exempt from the
 * implicit-broadcast restrictions of Android 8+. That is the whole reason this app
 * needs no foreground service and no battery-optimization exemption.
 *
 * `onReceive` runs on the main thread with roughly a ten-second budget, so the
 * work here is: reassemble, persist, enqueue, return. Everything network-shaped
 * happens later in [com.darsly.smslistener.work.SyncWorker].
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val appContext = context.applicationContext
        val locator = ServiceLocator.from(appContext)

        val message = runCatching { SmsExtractor.fromIntent(intent, locator.simSlotResolver) }
            .getOrNull() ?: return

        // Keep the broadcast alive across the database write without blocking the
        // main thread; finish() must run on every path or the process may be
        // killed with the write incomplete.
        val pendingResult = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                withTimeout(WRITE_TIMEOUT_MS) {
                    locator.smsRepository.onSmsReceived(message)
                }
            } catch (t: Throwable) {
                // Sender only — never the body, and never at a level that would
                // put message content into a bug report.
                Log.w(TAG, "Could not store incoming SMS from ${message.sender}: ${t.javaClass.simpleName}")
            } finally {
                pendingResult.finish()
            }
        }
    }

    private companion object {
        const val TAG = "SmsReceiver"
        const val WRITE_TIMEOUT_MS = 8_000L
    }
}
