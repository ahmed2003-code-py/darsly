import { Global, Module } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';
import { STORAGE_PROVIDER, StorageProvider } from './storage.provider';

/**
 * Binds StorageProvider to the driver named by STORAGE_DRIVER (local | s3).
 * Global so the video/playback modules can inject StorageProvider anywhere.
 */
@Global()
@Module({
  providers: [
    LocalStorageProvider,
    S3StorageProvider,
    {
      provide: STORAGE_PROVIDER,
      useFactory: (local: LocalStorageProvider, s3: S3StorageProvider) =>
        (process.env.STORAGE_DRIVER ?? 'local') === 's3' ? s3 : local,
      inject: [LocalStorageProvider, S3StorageProvider],
    },
    { provide: StorageProvider, useExisting: STORAGE_PROVIDER },
  ],
  exports: [StorageProvider, STORAGE_PROVIDER],
})
export class StorageModule {}
