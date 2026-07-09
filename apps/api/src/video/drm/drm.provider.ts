/**
 * DRM abstraction. Darsly ships with a native AES-128 HLS provider (clear-key
 * style: keys are AES-128, served only to an authorized, watermarked, signed
 * session — real server-side access control, but NOT hardware DRM). The
 * interface mirrors EME so a real multi-DRM vendor (Gumlet, Bunny Stream,
 * VdoCipher) can be dropped in later without touching the pipeline.
 *
 * HONEST SCOPE: AES-128 clear-key protects the *stream* (no raw MP4, keys are
 * gated per session). It does NOT provide Widevine/PlayReady/FairPlay hardware
 * robustness or HDCP output protection — those need a licensed CDM and a vendor
 * key server, stubbed below.
 */

export type DrmScheme = 'AES_128_CLEARKEY' | 'WIDEVINE' | 'PLAYREADY' | 'FAIRPLAY';

export interface PackageInput {
  assetId: string;
  /** absolute path to the decoded source the transcoder feeds ffmpeg */
  sourcePath: string;
  tenantId: string;
}

export interface Rendition {
  height: number;
  bandwidth: number;
  /** storage key of this rendition's media playlist */
  playlistKey: string;
}

export interface PackageResult {
  scheme: DrmScheme;
  /** storage key of the master playlist */
  masterKey: string;
  renditions: Rendition[];
  durationSec: number;
  /** id of the HlsEncryptionKey row used (native scheme only) */
  encryptionKeyId?: string;
}

/** What the player needs to start a protected session. */
export interface LicenseContext {
  assetId: string;
  studentId: string;
  sessionId: string;
  watermarkId: string;
  /** teacher/admin preview (no persisted PlaybackSession to re-check) */
  preview?: boolean;
}

export interface PlaybackCredentials {
  scheme: DrmScheme;
  /** signed URL of the master playlist */
  masterUrl: string;
  /** signed URL the player fetches the decryption key from (native scheme) */
  keyUrl?: string;
  /** EME license-server URL for hardware DRM schemes (vendor-provided) */
  licenseServerUrl?: string;
  /** additional EME init headers a real CDM would need */
  drmHeaders?: Record<string, string>;
}

/**
 * A DRM provider both PACKAGES a source into protected renditions and, at
 * playback time, issues the CREDENTIALS a player needs (key URL or EME license
 * endpoint). Swapping providers swaps both halves together.
 */
export interface IDrmProvider {
  readonly scheme: DrmScheme;
  /** true when a licensed CDM / vendor key server backs this provider */
  readonly hardwareBacked: boolean;

  package(input: PackageInput): Promise<PackageResult>;

  issueCredentials(ctx: LicenseContext): Promise<PlaybackCredentials>;
}

export const DRM_PROVIDER = Symbol('DRM_PROVIDER');
