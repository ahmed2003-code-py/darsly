package com.darsly.smslistener

import android.app.Application
import com.darsly.smslistener.di.ServiceLocator
import com.darsly.smslistener.work.WorkScheduler

class DarslyListenerApp : Application() {

    override fun onCreate() {
        super.onCreate()
        // Registering the periodic safety net here (rather than after verification)
        // means it is also restored when the process starts cold after a reboot.
        // The worker itself no-ops while the device is not registered.
        if (ServiceLocator.from(this).sessionStore.isRegistered()) {
            WorkScheduler.ensureMaintenance(this)
        }
    }
}
