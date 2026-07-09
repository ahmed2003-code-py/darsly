/**
 * @darsly/shared-types
 * Single source of truth for enums and API contracts shared by apps/api and apps/web.
 * Enum string values MUST stay in sync with the Prisma schema enums.
 */

// ── Roles & auth ────────────────────────────────────────────────────────────

export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  TEACHER = 'TEACHER',
  STUDENT = 'STUDENT',
}

export enum TeacherStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  /** user id */
  sub: string;
  role: Role;
  /** teacher tenant id when role=TEACHER */
  tenantId?: string;
  /** device session id — lets us kill exactly one device */
  sessionId: string;
}

export interface RequestOtpDto {
  /** E.164, Egyptian numbers like +2010xxxxxxxx */
  phone: string;
}

export interface VerifyOtpDto {
  phone: string;
  code: string;
  /** free-form device label, e.g. "Chrome on Android" */
  deviceName?: string;
}

export interface LoginPasswordDto {
  emailOrPhone: string;
  password: string;
  deviceName?: string;
}

// ── Catalog ────────────────────────────────────────────────────────────────

export enum CoursePricingModel {
  ONE_TIME = 'ONE_TIME',
  MONTHLY_SUBSCRIPTION = 'MONTHLY_SUBSCRIPTION',
  BUNDLE = 'BUNDLE',
}

export enum CourseStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export enum LessonType {
  VIDEO = 'VIDEO',
  QUIZ = 'QUIZ',
  ASSIGNMENT = 'ASSIGNMENT',
}

export enum EnrollmentStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

// ── Payments & ledger ──────────────────────────────────────────────────────

export enum LedgerEntryType {
  ENROLLMENT_REVENUE = 'ENROLLMENT_REVENUE',
  PLATFORM_COMMISSION = 'PLATFORM_COMMISSION',
  PAYOUT = 'PAYOUT',
  REFUND = 'REFUND',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum PayoutMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  VODAFONE_CASH = 'VODAFONE_CASH',
  INSTAPAY = 'INSTAPAY',
}

export enum PayoutStatus {
  REQUESTED = 'REQUESTED',
  APPROVED = 'APPROVED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  REJECTED = 'REJECTED',
}

// ── Security suite ─────────────────────────────────────────────────────────

export enum SecurityEventType {
  MULTI_IP_PLAYBACK = 'MULTI_IP_PLAYBACK',
  SESSION_LIMIT_KICK = 'SESSION_LIMIT_KICK',
  DEVTOOLS_DETECTED = 'DEVTOOLS_DETECTED',
  RAPID_SEEK_ANOMALY = 'RAPID_SEEK_ANOMALY',
  VIEW_CAP_EXCEEDED = 'VIEW_CAP_EXCEEDED',
  LEAK_TRACED = 'LEAK_TRACED',
  MANUAL_FLAG = 'MANUAL_FLAG',
}

export enum SecurityEventSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

/** What the roving overlay renders; also encoded into the watermark ID. */
export interface WatermarkPayload {
  studentId: string;
  studentName: string;
  studentPhone: string;
  /** short code shown on screen, e.g. DRS-89421-A8X9 — leak-trace lookup key */
  watermarkId: string;
  sessionId: string;
  issuedAt: string; // ISO timestamp
}

/** DRM schemes; AES_128_CLEARKEY is the native default, others are vendor stubs. */
export enum DrmScheme {
  AES_128_CLEARKEY = 'AES_128_CLEARKEY',
  WIDEVINE = 'WIDEVINE',
  PLAYREADY = 'PLAYREADY',
  FAIRPLAY = 'FAIRPLAY',
}

export enum VideoAssetStatus {
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

/** Response from POST /playback/sessions — everything the player needs. */
export interface PlaybackTicket {
  playbackSessionId: string;
  preview: boolean;
  scheme: DrmScheme;
  /** signed URL of the HLS master playlist */
  masterUrl: string;
  /** signed URL of the AES key (native scheme) */
  keyUrl?: string;
  /** EME license server (hardware DRM schemes) */
  licenseServerUrl?: string;
  durationSec: number;
  watermark: WatermarkPayload;
  /** invisible/steganographic leak-trace token */
  stegToken: string;
}

// ── Notifications ──────────────────────────────────────────────────────────

export enum NotificationType {
  ANNOUNCEMENT = 'ANNOUNCEMENT',
  ENROLLMENT_APPROVED = 'ENROLLMENT_APPROVED',
  NEW_LESSON = 'NEW_LESSON',
  CHAT_MESSAGE = 'CHAT_MESSAGE',
  QUIZ_GRADED = 'QUIZ_GRADED',
  PAYOUT_STATUS = 'PAYOUT_STATUS',
  SECURITY_ALERT = 'SECURITY_ALERT',
  LIVE_SESSION_REMINDER = 'LIVE_SESSION_REMINDER',
  SUBSCRIPTION_RENEWAL = 'SUBSCRIPTION_RENEWAL',
}

// ── Generic API envelope ───────────────────────────────────────────────────

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  error?: string;
}
