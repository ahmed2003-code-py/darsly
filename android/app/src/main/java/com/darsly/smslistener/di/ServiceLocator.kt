package com.darsly.smslistener.di

import android.content.Context
import android.os.Build
import com.darsly.smslistener.BuildConfig
import com.darsly.smslistener.data.local.AppDatabase
import com.darsly.smslistener.data.remote.ApiClient
import com.darsly.smslistener.data.remote.DeviceApi
import com.darsly.smslistener.data.repo.DeviceRepository
import com.darsly.smslistener.data.repo.SmsRepository
import com.darsly.smslistener.data.security.KeystoreSessionStore
import com.darsly.smslistener.data.security.SessionStore
import com.darsly.smslistener.data.security.SettingsStore
import com.darsly.smslistener.notify.Notifier
import com.darsly.smslistener.sms.SimSlotResolver
import com.darsly.smslistener.work.WorkScheduler

/**
 * Manual dependency graph.
 *
 * A dependency-injection framework would earn its keep in a larger app; here it
 * would be one more compile-time dependency for eight objects. Everything is lazy
 * so a broadcast that arrives with the process cold pays only for the database and
 * the repository it actually touches.
 */
class ServiceLocator private constructor(context: Context) {

    private val appContext = context.applicationContext

    val database: AppDatabase by lazy { AppDatabase.build(appContext) }

    val sessionStore: SessionStore by lazy { KeystoreSessionStore(appContext) }

    val settingsStore: SettingsStore by lazy { SettingsStore(appContext) }

    val simSlotResolver: SimSlotResolver by lazy { SimSlotResolver(appContext) }

    private val notifier: Notifier by lazy { Notifier(appContext, settingsStore) }

    val api: DeviceApi by lazy { ApiClient.create(BuildConfig.API_BASE_URL, sessionStore) }

    val smsRepository: SmsRepository by lazy {
        SmsRepository(
            messages = database.smsMessages(),
            rules = database.senderRules(),
            api = api,
            onForwardableMessage = { brand, body ->
                // A payment SMS was queued: tell the user, then ask WorkManager to
                // deliver it. Both are side effects of storage, never preconditions
                // for it.
                notifier.paymentSmsDetected(brand, body)
                WorkScheduler.syncNow(appContext)
            },
        )
    }

    val deviceRepository: DeviceRepository by lazy {
        DeviceRepository(
            api = api,
            session = sessionStore,
            smsRepository = smsRepository,
            deviceModel = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            appVersion = BuildConfig.VERSION_NAME,
        )
    }

    companion object {
        @Volatile
        private var instance: ServiceLocator? = null

        fun from(context: Context): ServiceLocator =
            instance ?: synchronized(this) {
                instance ?: ServiceLocator(context).also { instance = it }
            }
    }
}
