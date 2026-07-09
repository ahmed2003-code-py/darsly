import { Logger } from '@nestjs/common';
import {
  DrmScheme,
  IDrmProvider,
  LicenseContext,
  PackageInput,
  PackageResult,
  PlaybackCredentials,
} from './drm.provider';

/**
 * Hardware-DRM vendor stubs. Each is a drop-in point for a licensed multi-DRM
 * service (Gumlet / Bunny Stream / VdoCipher / Google Widevine + Microsoft
 * PlayReady + Apple FairPlay). They implement IDrmProvider so wiring one up is:
 *   1. set DRM_SCHEME + the vendor's API key envs,
 *   2. fill package()/issueCredentials() with the vendor SDK calls.
 * Until then they throw with a precise message rather than silently degrading —
 * a half-configured DRM path must never fall back to serving unprotected media.
 */
abstract class VendorDrmStub implements IDrmProvider {
  abstract readonly scheme: DrmScheme;
  readonly hardwareBacked = true;
  protected readonly logger = new Logger(this.constructor.name);

  protected notConfigured(): never {
    throw new Error(
      `${this.scheme} DRM provider is a stub. Configure a licensed multi-DRM vendor ` +
        `(Gumlet/Bunny/VdoCipher) and implement package()/issueCredentials() before enabling it.`,
    );
  }

  async package(_input: PackageInput): Promise<PackageResult> {
    return this.notConfigured();
  }
  async issueCredentials(_ctx: LicenseContext): Promise<PlaybackCredentials> {
    return this.notConfigured();
  }
}

/** Google Widevine (Android, Chrome, Firefox, smart TVs). */
export class WidevineDrmProvider extends VendorDrmStub {
  readonly scheme = 'WIDEVINE' as const;
}

/** Microsoft PlayReady (Edge, Windows, Xbox). */
export class PlayReadyDrmProvider extends VendorDrmStub {
  readonly scheme = 'PLAYREADY' as const;
}

/** Apple FairPlay Streaming (Safari, iOS, tvOS). */
export class FairPlayDrmProvider extends VendorDrmStub {
  readonly scheme = 'FAIRPLAY' as const;
}
