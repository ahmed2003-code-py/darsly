package com.darsly.smslistener.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.darsly.smslistener.di.ServiceLocator
import com.darsly.smslistener.ui.inbox.InboxScreen
import com.darsly.smslistener.ui.permission.PermissionScreen
import com.darsly.smslistener.ui.settings.SettingsScreen
import com.darsly.smslistener.ui.theme.DarslyTheme
import com.darsly.smslistener.ui.verify.VerifyScreen
import com.darsly.smslistener.work.WorkScheduler

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DarslyTheme {
                AppRoot()
            }
        }
    }
}

/**
 * Three screens and one rule: you are wherever your setup actually is.
 *
 * The route is derived from real state — is there a verified session, is the SMS
 * permission granted — rather than from a navigation history. Revoking the
 * permission in system settings or disconnecting the device therefore lands the
 * user back on the right screen without any explicit navigation.
 */
@Composable
private fun AppRoot() {
    val context = LocalContext.current
    val locator = remember(context) { ServiceLocator.from(context) }
    val registered by locator.sessionStore.registered.collectAsStateWithLifecycle()

    var smsPermissionGranted by remember { mutableStateOf(context.hasSmsPermission()) }
    var showSettings by remember { mutableStateOf(false) }

    // The user may grant or revoke the permission in system settings while we are
    // in the background, so re-read it on every resume rather than trusting a
    // cached value.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        smsPermissionGranted = context.hasSmsPermission()
        if (registered && smsPermissionGranted) {
            WorkScheduler.ensureMaintenance(context)
            // Refresh rules as well as draining the outbox: a sender rule added
            // on the backend should take effect the moment the user opens the
            // app, not six hours later.
            WorkScheduler.refreshAndSyncNow(context)
        }
    }

    when {
        !registered -> VerifyScreen()

        !smsPermissionGranted -> PermissionScreen(
            onGranted = {
                smsPermissionGranted = true
                WorkScheduler.ensureMaintenance(context)
            },
        )

        showSettings -> SettingsScreen(onBack = { showSettings = false })

        else -> InboxScreen(onOpenSettings = { showSettings = true })
    }
}

private fun android.content.Context.hasSmsPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) ==
        PackageManager.PERMISSION_GRANTED
