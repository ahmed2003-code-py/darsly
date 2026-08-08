package com.darsly.smslistener.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import com.darsly.smslistener.domain.SenderMatchType

class Converters {
    @TypeConverter fun fromSyncStatus(value: SyncStatus): String = value.name

    @TypeConverter fun toSyncStatus(value: String): SyncStatus =
        runCatching { SyncStatus.valueOf(value) }.getOrDefault(SyncStatus.LOCAL_ONLY)

    @TypeConverter fun fromMatchType(value: SenderMatchType): String = value.name

    @TypeConverter fun toMatchType(value: String): SenderMatchType =
        runCatching { SenderMatchType.valueOf(value) }.getOrDefault(SenderMatchType.CONTAINS)
}

/**
 * The device-local store.
 *
 * Protection: the file lives in the app's private storage (not world-readable,
 * not on external storage), backup and device-transfer are disabled in the
 * manifest, and "delete stored messages" in Settings wipes it. Full at-rest
 * encryption (SQLCipher) is intentionally *not* pulled in — it would add a heavy
 * native dependency, and the practical threat here (a lost, unlocked phone) is
 * already covered by device encryption plus the ability to revoke the device
 * server-side. See README → Security.
 */
@Database(
    entities = [SmsMessageEntity::class, SenderRuleEntity::class],
    version = 1,
    exportSchema = false,
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {

    abstract fun smsMessages(): SmsMessageDao

    abstract fun senderRules(): SenderRuleDao

    companion object {
        /**
         * Note the absence of `fallbackToDestructiveMigration()`: this database is
         * an outbox, and silently dropping it on a schema bump would lose messages
         * that were never delivered. Future versions must ship a real Migration.
         */
        fun build(context: Context): AppDatabase =
            Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, "darsly-listener.db")
                .build()
    }
}
