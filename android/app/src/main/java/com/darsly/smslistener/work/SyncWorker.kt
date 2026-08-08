package com.darsly.smslistener.work

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.darsly.smslistener.data.repo.SyncOutcome
import com.darsly.smslistener.di.ServiceLocator

/**
 * Drains the outbox.
 *
 * WorkManager owns the retry schedule (exponential backoff, network constraint,
 * survives process death and reboot), so this worker only has to answer one
 * question: is there still undelivered work?
 *
 * Returning `failure()` after the attempt ceiling does **not** discard anything —
 * the rows stay in the database and the periodic maintenance run picks them up.
 */
class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val locator = ServiceLocator.from(applicationContext)

        // Not registered (or just unregistered): nothing may be uploaded. The
        // messages stay stored locally.
        if (!locator.sessionStore.isRegistered()) return Result.success()

        return try {
            when (locator.smsRepository.syncPending()) {
                SyncOutcome.DONE -> Result.success()
                SyncOutcome.RETRY ->
                    if (runAttemptCount >= MAX_WORKER_ATTEMPTS) Result.failure() else Result.retry()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Sync run failed: ${t.javaClass.simpleName}")
            if (runAttemptCount >= MAX_WORKER_ATTEMPTS) Result.failure() else Result.retry()
        }
    }

    private companion object {
        const val TAG = "SyncWorker"

        /** After this many backoff rounds, hand over to the periodic worker. */
        const val MAX_WORKER_ATTEMPTS = 8
    }
}
