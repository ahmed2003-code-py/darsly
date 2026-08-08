package com.darsly.smslistener.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.darsly.smslistener.di.ServiceLocator

/**
 * The periodic safety net, and the reason a message can survive almost anything.
 *
 * WorkManager re-registers periodic work after a reboot or an app update, so this
 * runs even if every one-shot sync attempt was exhausted while the phone was
 * offline. Each pass refreshes the sender rules, sends a heartbeat so the backend
 * knows the device is alive, and drains whatever is still pending.
 */
class MaintenanceWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val locator = ServiceLocator.from(applicationContext)
        if (!locator.sessionStore.isRegistered()) return Result.success()

        // Each step is independent and non-throwing; one failing must not stop
        // the others — draining the outbox is the important one.
        locator.deviceRepository.refreshRules()
        locator.deviceRepository.heartbeat()
        locator.smsRepository.syncPending()

        return Result.success()
    }
}
