package com.darsly.smslistener.sms

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionManager
import androidx.core.content.ContextCompat

/**
 * Maps a subscription id to a human SIM slot (0-based) on dual-SIM devices.
 *
 * Entirely optional: this needs READ_PHONE_STATE, and the app is fully functional
 * without it — the subscription id is still recorded, only the friendlier slot
 * number is missing. Nothing here ever throws into the SMS receive path.
 */
class SimSlotResolver(private val context: Context) {

    // Guarded by hasPermission() below; lint cannot see through the helper.
    @SuppressLint("MissingPermission")
    fun slotFor(subscriptionId: Int): Int? {
        if (!hasPermission()) return null
        return runCatching {
            ContextCompat.getSystemService(context, SubscriptionManager::class.java)
                ?.getActiveSubscriptionInfo(subscriptionId)
                ?.simSlotIndex
        }.getOrNull()
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED
}
