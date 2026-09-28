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
  /** Non-teaching, non-learning account; authority is membership-only. */
  STAFF = 'STAFF',
  /**
   * A guest who bought one live seat without an account. Its token is bound
   * to that one session and refused on every route not marked @GuestAllowed.
   */
  GUEST = 'GUEST',
  /** A parent/guardian: sees only children an ACTIVE GuardianLink gives them. */
  GUARDIAN = 'GUARDIAN',
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
  /** GUEST only: the one live session this token may act on. */
  liveSessionId?: string;
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

/**
 * What a course's exam is for.
 *
 * FINAL is the paper at the end, about what was just studied: it locks nothing,
 * and passing it is what completes the course. GATE is a placement test — until
 * it is passed the course is shut except for the exam, its remedial lesson and
 * the free previews.
 */
/**
 * What a course is for, which decides what its builder looks like.
 *
 * Nothing student-facing reads this: enrolment, pricing, publishing and the
 * exam engine behave identically either way. It exists so a course whose whole
 * content is one exam is not edited through a screen asking for sections,
 * lessons and an intro clip.
 */
export enum CourseKind {
  STANDARD = 'STANDARD',
  EXAM = 'EXAM',
}

export enum CourseExamMode {
  GATE = 'GATE',
  FINAL = 'FINAL',
}

export enum LessonType {
  VIDEO = 'VIDEO',
  QUIZ = 'QUIZ',
  ASSIGNMENT = 'ASSIGNMENT',
}

export enum QuestionType {
  MCQ = 'MCQ',
  TRUE_FALSE = 'TRUE_FALSE',
  SHORT_ANSWER = 'SHORT_ANSWER',
}

export enum EnrollmentStatus {
  /** A payment has been submitted and is waiting to be confirmed. */
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  /** A free-course request under an academy's MANUAL/DEMO enrollmentMode,
   *  waiting on staff approval. Never used for a paid course. */
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  ACTIVE = 'ACTIVE',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export enum AcademyEnrollmentMode {
  AUTOMATIC = 'AUTOMATIC',
  MANUAL = 'MANUAL',
  DEMO = 'DEMO',
}

// ── Academy (multi-tenant SaaS) ───────────────────────────────────────────

export enum AcademyRole {
  OWNER = 'OWNER',
  TEACHER = 'TEACHER',
  ASSISTANT = 'ASSISTANT',
  STUDENT = 'STUDENT',
}

export enum AcademyStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

/** Classification only: a teacher's own workspace vs an admin-created organisation. */
export enum AcademyKind {
  PERSONAL = 'PERSONAL',
  CENTER = 'CENTER',
}

// ── Challenges (gamified) ──────────────────────────────────────────────────
// Student-facing name is always "Challenge", never "Exam".

export enum ChallengeType {
  PRACTICE = 'PRACTICE',
  RANKED = 'RANKED',
}

export enum ChallengeStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  ARCHIVED = 'ARCHIVED',
}

export enum ChallengeScoring {
  STANDARD = 'STANDARD',
  SPEED_BASED = 'SPEED_BASED',
}

export enum ChallengeAnswerReveal {
  IMMEDIATE = 'IMMEDIATE',
  AFTER_SUBMISSION = 'AFTER_SUBMISSION',
  AFTER_CLOSE = 'AFTER_CLOSE',
  NEVER = 'NEVER',
}

export enum ChallengeRandomize {
  NONE = 'NONE',
  QUESTIONS = 'QUESTIONS',
  ANSWERS = 'ANSWERS',
  BOTH = 'BOTH',
}

export enum ChallengeAttemptStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  TIMED_OUT = 'TIMED_OUT',
  ABANDONED = 'ABANDONED',
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
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentMethod {
  INSTAPAY = 'INSTAPAY',
  VODAFONE_CASH = 'VODAFONE_CASH',
  BANK_TRANSFER = 'BANK_TRANSFER',
  OTHER = 'OTHER',
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
  /** seconds to resume from (last watched position); 0 = start from the top */
  resumeAtSec?: number;
  watermark: WatermarkPayload;
  /** invisible/steganographic leak-trace token */
  stegToken: string;
}

// ── Chat & realtime ────────────────────────────────────────────────────────

export enum ChatThreadType {
  DM = 'DM',
  QA = 'QA',
}

/** The message a reply is answering, as much of it as the quote needs. */
export interface ChatReplyToDto {
  id: string;
  senderName: string;
  /** Empty when the quoted message is a voice note or attachments only. */
  body: string;
  isVoice: boolean;
  /** Set when the quoted message carried attachments (the first non-voice one's kind). */
  attachmentKind?: ChatAttachmentKind | null;
  /** The first non-voice attachment's name, and how many there were. */
  attachmentName?: string | null;
  attachmentCount?: number;
  /** The original was removed: draw "Message unavailable", do not jump. */
  unavailable?: boolean;
}

/**
 * Who someone is inside a conversation — frozen on each message when it is
 * sent, so a later role change never re-labels history. Not the global
 * account role: an assistant's account may be a teacher's.
 */
export type ChatSenderKind = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT' | 'GUARDIAN' | 'ADMIN';

export interface ChatParticipantDto {
  id: string;
  name: string;
  /** A signed, cacheable image URL — never inline image data. */
  avatarUrl: string | null;
  kind: ChatSenderKind;
  /** An academy-chosen title such as "Student Support", when there is one. */
  title: string | null;
}

export type ChatAttachmentKind = 'IMAGE' | 'FILE' | 'VOICE';

export interface ChatAttachmentDto {
  id: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Signed, short-lived: the file itself (images: the full re-encoded image). */
  url: string;
  /** Signed: a small preview for images; null for other files. */
  previewUrl: string | null;
  /** Signed: the same bytes served as a download. */
  downloadUrl: string;
  /** VOICE only: the recorded length in seconds. */
  durationSec?: number | null;
}

/** The reactions a message may carry. Small and professional on purpose. */
export const CHAT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export type ChatReactionEmoji = (typeof CHAT_REACTIONS)[number];

export interface ChatReactionDto {
  emoji: string;
  count: number;
  /** The viewer's own reaction is this one. */
  mine: boolean;
  /** Who reacted, for a tooltip; capped. */
  names: string[];
}

/** Pushed when a message's reactions change, per recipient (so `mine` is theirs). */
export interface ChatReactionEvent {
  threadId: string;
  messageId: string;
  reactions: ChatReactionDto[];
}

/** Pushed when someone's read position in a conversation moves forward. */
export interface ChatSeenEvent {
  threadId: string;
  userId: string;
  lastReadAt: string;
}

export interface ChatMessageDto {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  senderRole: Role;
  body: string;
  readAt: string | null;
  createdAt: string;
  mine?: boolean;
  /** Set when this message answers another one. */
  replyTo?: ChatReplyToDto | null;
  /** A voice note: `body` is empty and the audio is fetched by message id. */
  audio?: { durationSec: number; bytes: number } | null;
  /** Set when the message was written about a lesson, and where in its video. */
  lesson?: { id: string; title: string; atSec: number | null } | null;
  /** The sender's own id for the send; present only on the sender's copy. */
  clientMessageId?: string | null;
  /** Who sent it, as they were in this conversation when they sent it. */
  sender?: ChatParticipantDto;
  attachments?: ChatAttachmentDto[];
  reactions?: ChatReactionDto[];
  /** Deleted for everyone by its sender: a tombstone with no content. */
  deleted?: boolean;
  /** GROUP, on the sender's own copy: how many other members have read it. */
  seenCount?: number;
}

/**
 * A message was deleted. `everyone`: it is now a tombstone for all
 * participants. `me`: the viewer hid it (sent only to their own tabs).
 */
export interface ChatDeletedEvent {
  threadId: string;
  messageId: string;
  scope: 'everyone' | 'me';
}

export interface ChatThreadDto {
  id: string;
  type: ChatThreadType;
  tenantId: string;
  studentId: string;
  /** the other party's display name (student sees teacher, teacher sees student) */
  counterpartName: string;
  counterpartAvatarUrl: string | null;
  lessonId: string | null;
  lessonTitle?: string | null;
  videoTimestampSec: number | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unread: number;
  updatedAt: string;
  /** The last message was sent by the viewer (the list prefixes "You:"). */
  lastMessageMine?: boolean;
  /** How far the viewer has read — the conversation opens its unread divider here. */
  myLastReadAt?: string | null;
  /** How far the other side has read — drives ✓✓ on the viewer's messages. */
  counterpartLastReadAt?: string | null;
  counterpartKind?: ChatSenderKind;
  /** An assistant counterpart's title in the academy ("Student Support"). */
  counterpartTitle?: string | null;
  /** DIRECT: one named person. TEAM: the academy's support team. GROUP: a class group's chat. */
  kind?: 'DIRECT' | 'TEAM' | 'GROUP';
  /** GROUP only. */
  groupId?: string | null;
  groupName?: string | null;
  groupMode?: GroupChatMode | null;
  memberCount?: number;
  archived?: boolean;
  academyId?: string | null;
  academyName?: string | null;
  /** Who the learner side is: the student, or one of their guardians. */
  learnerKind?: 'STUDENT' | 'GUARDIAN';
  /** The student the conversation is about (a guardian's child, for staff and multi-child guardians). */
  studentName?: string | null;
  guardianRelationship?: GuardianRelationship | null;
  /** TEAM only: who has it, and whether it is resolved. */
  assigneeUserId?: string | null;
  assigneeName?: string | null;
  resolvedAt?: string | null;
}

export type GuardianRelationship = 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'OTHER';

/** OPEN: everyone writes. ANNOUNCEMENTS: staff write, students read. */
export type GroupChatMode = 'OPEN' | 'ANNOUNCEMENTS';

/** A class group's chat, as its info panel shows it. */
export interface GroupChatInfoDto {
  threadId: string | null;
  groupId: string;
  name: string;
  academyName: string | null;
  enabled: boolean;
  mode: GroupChatMode;
  memberCount: number;
  staff: { id: string; name: string; avatarUrl: string | null; kind: ChatSenderKind; title: string | null }[];
  /** Students, for staff only. */
  students: { id: string; name: string; avatarUrl: string | null }[] | null;
  /** What the viewer may do: write now, and manage the chat (on/off, mode). */
  can: { send: boolean; manage: boolean };
}

/** The staff inbox's views of the conversation list. */
export type InboxFilter = 'all' | 'mine' | 'unassigned' | 'unread' | 'resolved';

/** What staff see beside a conversation: who, where, which of their courses. */
export interface ChatContextDto {
  student: { id: string; name: string; avatarUrl: string | null };
  academy: { id: string; name: string } | null;
  courses: { id: string; title: string; status: string }[];
  guardian: { name: string; relationship: GuardianRelationship } | null;
  guardians: number;
  canManageGuardians: boolean;
  kind: 'DIRECT' | 'TEAM';
  assignee: { id: string; name: string } | null;
  resolvedAt: string | null;
  can: { claim: boolean; assign: boolean; resolve: boolean };
}

/** Someone a student can start a conversation with (GET /chat/contacts). */
export interface ChatContactDto {
  /** OWNER: the teacher. ASSISTANT: a directly-reachable assistant. TEAM: the academy's support team. */
  kind: 'OWNER' | 'ASSISTANT' | 'TEAM';
  /** A guardian's contacts are per child: which child the conversation is about. */
  studentId?: string;
  studentName?: string;
  /** a teacher: their tenant */
  tenantId?: string;
  /** an assistant: who they are, and in which academy */
  staffUserId?: string;
  academyId: string;
  academyName: string | null;
  name: string;
  avatarUrl: string | null;
  title: string | null;
}

/** Socket.io event names (server↔client), kept in one place to avoid typos. */
export const RealtimeEvents = {
  // client → server
  JOIN_THREAD: 'chat:join',
  LEAVE_THREAD: 'chat:leave',
  SEND_MESSAGE: 'chat:send',
  TYPING: 'chat:typing',
  MARK_READ: 'chat:read',
  // server → client
  MESSAGE: 'chat:message',
  REACTION: 'chat:reaction',
  SEEN: 'chat:seen',
  DELETED: 'chat:deleted',
  THREAD_UPDATED: 'chat:thread',
  TYPING_ECHO: 'chat:typing',
  NOTIFICATION: 'notification:new',
  UNREAD_COUNT: 'notification:unread',
} as const;

export interface SendMessagePayload {
  threadId?: string;
  /** the message being answered */
  replyToId?: string;
  /** when starting a new thread, the teacher tenant to message */
  tenantId?: string;
  /** when a teacher starts the thread, the student they are writing to */
  studentId?: string;
  /** the academy, when staff write outside their own workspace or a student writes to an assistant */
  academyId?: string;
  /** when a student starts a thread with an assistant */
  staffUserId?: string;
  /** the academy's support team (with academyId; a guardian also names studentId) */
  team?: boolean;
  body: string;
  /** Q&A pinned to a lesson moment */
  lessonId?: string;
  videoTimestampSec?: number;
  /**
   * The client's id for this send (a UUID). Retrying with the same id returns
   * the message already stored instead of posting it again.
   */
  clientMessageId?: string;
  /** PENDING uploads (POST /chat/attachments) to send with this message. */
  attachmentIds?: string[];
}

// ── Progress & student comfort ───────────────────────────────────────────────

export interface ContinueWatchingItem {
  lessonId: string;
  lessonTitle: string;
  courseId: string;
  courseTitle: string;
  thumbnailUrl: string | null;
  teacherName: string;
  watchedPct: number;
  lastPositionSec: number;
  durationSec: number;
}

export interface StudentProgressSummary {
  currentStreak: number;
  longestStreak: number;
  weeklyGoalLessons: number;
  lessonsCompletedThisWeek: number;
  weeklyGoalPct: number;
  totalLessonsCompleted: number;
  activeCourses: number;
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

// ── Platform Admin look (SUPER_ADMIN console theme) ─────────────────────────

export * from './admin-theme';
export * from './live-rules';
export * from './live-commerce';
