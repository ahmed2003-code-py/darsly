import { Module } from '@nestjs/common';
import { SignedUrlService } from '../playback/signed-url.service';
import { StorageProvider } from '../storage/storage.provider';
import { DRM_PROVIDER } from './drm/drm.provider';
import { NativeAesDrmProvider } from './drm/native-aes.provider';
import {
  FairPlayDrmProvider,
  PlayReadyDrmProvider,
  WidevineDrmProvider,
} from './drm/vendor-drm.stubs';
import { HlsKeyService } from './hls-key.service';
import { TranscodeService } from './transcode.service';
import { VideoProcessingService } from './video-processing.service';

/**
 * Selects the active DRM provider by DRM_SCHEME (default AES_128_CLEARKEY, the
 * native provider). Hardware-DRM vendors are wired but stubbed — enabling one
 * requires implementing its package()/issueCredentials() against a licensed
 * multi-DRM service.
 */
@Module({
  providers: [
    TranscodeService,
    HlsKeyService,
    SignedUrlService,
    NativeAesDrmProvider,
    WidevineDrmProvider,
    PlayReadyDrmProvider,
    FairPlayDrmProvider,
    {
      provide: DRM_PROVIDER,
      useFactory: (
        native: NativeAesDrmProvider,
        widevine: WidevineDrmProvider,
        playready: PlayReadyDrmProvider,
        fairplay: FairPlayDrmProvider,
      ) => {
        switch (process.env.DRM_SCHEME) {
          case 'WIDEVINE': return widevine;
          case 'PLAYREADY': return playready;
          case 'FAIRPLAY': return fairplay;
          default: return native;
        }
      },
      inject: [NativeAesDrmProvider, WidevineDrmProvider, PlayReadyDrmProvider, FairPlayDrmProvider],
    },
    {
      provide: NativeAesDrmProvider,
      useFactory: (
        transcoder: TranscodeService,
        keys: HlsKeyService,
        storage: StorageProvider,
        signer: SignedUrlService,
      ) => new NativeAesDrmProvider(transcoder, keys, storage, signer),
      inject: [TranscodeService, HlsKeyService, StorageProvider, SignedUrlService],
    },
    VideoProcessingService,
  ],
  exports: [VideoProcessingService, HlsKeyService, SignedUrlService, DRM_PROVIDER],
})
export class VideoModule {}
