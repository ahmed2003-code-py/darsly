package com.darsly.smslistener.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * All background scheduling in one place.
 *
 * Only WorkManager is used — no foreground service to hold the process open, and
 * no request to be excluded from battery optimisation. Incoming SMS wake the app
 * on their own; between them there is nothing worth keeping alive.
 */
object WorkScheduler {

    private const val SYNC_WORK = "darsly-sms-sync"
    private const val MAINTENANCE_WORK = "darsly-maintenance"
    private const val REFRESH_WORK = "darsly-refresh"

    private val networkRequired = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * Ask for a sync pass. Enqueued as unique work with APPEND_OR_REPLACE: a
     * message that arrives while a run is in flight gets its own follow-up run
     * rather than being swallowed by the in-progress one.
     */
    fun syncNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(networkRequired)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(SYNC_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    /**
     * A full maintenance pass right now: refresh the rules, re-check anything
     * previously unclassified, then drain the outbox. Used when the user opens
     * the app or taps "Sync now", so a rule added on the backend takes effect
     * immediately rather than waiting for the next periodic run.
     */
    fun refreshAndSyncNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<MaintenanceWorker>()
            .setConstraints(networkRequired)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(REFRESH_WORK, ExistingWorkPolicy.REPLACE, request)
    }

    /** Registered once at startup; WorkManager restores it across reboots. */
    fun ensureMaintenance(context: Context) {
        val request = PeriodicWorkRequestBuilder<MaintenanceWorker>(6, TimeUnit.HOURS)
            .setConstraints(networkRequired)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            MAINTENANCE_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** On unregister: stop all background work for this device. */
    fun cancelAll(context: Context) {
        WorkManager.getInstance(context).apply {
            cancelUniqueWork(SYNC_WORK)
            cancelUniqueWork(MAINTENANCE_WORK)
            cancelUniqueWork(REFRESH_WORK)
        }
    }
}
