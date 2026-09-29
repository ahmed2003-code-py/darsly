import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LiveHandState, LiveRtcPurpose, LiveTrackKind } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { LiveService, PRESENCE_GRACE_SEC } from '../live.service';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CfSessionDescription, toHttpError } from '../providers/cloudflare-realtime.client';
import { canSpeak, HandAction, nextHandState, STUDENT_ACTIONS, TEACHER_ACTIONS } from './live-hand';
import {
  effectivePolicy,
  type CameraControl,
  type CameraPolicy,
  type EffectivePolicy,
  type MicControl,
  type MicPolicy,
} from './classroom-policy';

/** What a student's page may report about their camera (never more than this). */
export const CAMERA_REPORTS = ['DENIED', 'NO_DEVICE', 'FAILED'] as const;
export type CameraReport = (typeof CAMERA_REPORTS)[number];
/** A camera reminder to one student at most this often. */
const NUDGE_EVERY_MS = 60_000;

interface Controls {
  mic: MicControl;
  camera: CameraControl;
  cameraReport: CameraReport | null;
}
const DEFAULT_CONTROLS: Controls = { mic: 'DEFAULT', camera: 'DEFAULT', cameraReport: null };
import { transcriptCaptureState } from '../transcription/capture-state';
import { bonusTotals } from '../bonus/bonus-totals';

/**
 * How many students may speak at once. A class is a teacher and an audience;
 * a handful of voices keeps it one, and keeps every student's download to the
 * teacher plus a few small streams.
 */
export function maxSpeakers(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIVE_MAX_SPEAKERS);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 3;
}

/** What each side of the class may send. */
const TEACHER_KINDS: readonly LiveTrackKind[] = ['AUDIO', 'VIDEO', 'SCREEN', 'SCREEN_AUDIO'];
const STUDENT_KINDS: readonly LiveTrackKind[] = ['AUDIO', 'VIDEO'];

/**
 * The teacher's camera goes out in two layers: `h` (720p, up to 1.2 Mbps) and
 * `l` (a quarter of the size, up to 150 kbps). Each student receives one, and
 * their page moves between them with the link.
 */
export const SIMULCAST_RIDS = ['h', 'l'] as const;
export type SimulcastRid = (typeof SIMULCAST_RIDS)[number];

/** Coalesce a burst of changes (a class joining at once) into one event. */
const BROADCAST_COALESCE_MS = 250;

type Role = 'TEACHER' | 'STUDENT';

interface Gate {
  s: {
    id: string;
    roomName: string;
    startsAt: Date;
    durationMin: number;
    teacherUserId: string | null;
    micPolicy: MicPolicy;
    cameraPolicy: CameraPolicy;
  };
  role: Role;
  /** May run the class (see LiveService.canModerate). Always false for a student. */
  moderator: boolean;
}

export interface RtcState {
  sessionId: string;
  /** This run of the class; a different value means "the class was reopened — reconnect". */
  run: string;
  serverNow: string;
  me: {
    userId: string;
    role: Role;
    hand: LiveHandState;
    canPublish: boolean;
    /** May run the class: the controls are drawn only for them (the server checks again). */
    moderator: boolean;
    /** What this person may send and is asked to do, from the one policy function. */
    policy: EffectivePolicy;
    /** A student's own bonus points in this class. */
    bonus?: number;
  };
  maxSpeakers: number;
  /** The class's policies (everyone sees them: they explain the controls). */
  policies: { mic: MicPolicy; camera: CameraPolicy };
  /** A recording of this run is being made (the REC badge). */
  recording: boolean;
  /** The lesson's words are being kept for its transcript (everyone is told). */
  transcribing: boolean;
  /** The teacher's view only: the lesson's transcription mode (for the MANUAL switch). */
  transcription?: { mode: string; available: boolean };
  participants: {
    userId: string;
    name: string;
    role: Role;
    hand: LiveHandState;
    audio: boolean;
    video: boolean;
    screen: boolean;
    /** Moderators only: this participant's controls in this run (and what their page reported). */
    controls?: { mic: MicControl; camera: CameraControl; cameraReport: CameraReport | null };
    /** Moderators only: asked to have the camera on (EXPECTED, not exempt, not blocked). */
    cameraExpected?: boolean;
    /** Moderators only: bonus points given in this class, and whether they are a guest (no points). */
    bonus?: number;
    guest?: boolean;
  }[];
  tracks: { id: string; userId: string; kind: LiveTrackKind; role: Role }[];
  /** Moderators only: who holds a seat and is not in the room yet. */
  notJoined?: { userId: string; name: string; guest: boolean }[];
}

/**
 * The Cloudflare classroom, server side: who is connected, what they publish,
 * who may speak — and the gate every push and pull goes through.
 *
 * The rules are the ones the Daily classroom already had (the teacher and the
 * academy's staff lead the class; a booked student attends it; nobody enters
 * before it starts or after it ends), read from the database on every call —
 * never from the request. On top of them, what Cloudflare leaves to its
 * customer:
 *  - students receive by default and send nothing; sending needs the
 *    teacher's approval (LiveHand), is on its own connection, and is checked
 *    on every push;
 *  - only tracks this table lists — open, in this run, from someone allowed to
 *    send them — can be pulled, and the SFU session they come from is looked up
 *    here, never taken from the browser;
 *  - a revoke force-closes the student's tracks at the SFU, so it holds even
 *    against a browser that ignores it.
 */
@Injectable()
export class LiveRtcService {
  private readonly logger = new Logger(LiveRtcService.name);
  private readonly pendingBroadcast = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly cloudflare: CloudflareLiveProvider,
    private readonly realtime: RealtimeService,
  ) {}

  private get client() {
    return this.cloudflare.client;
  }

  // ── The gate ───────────────────────────────────────────────────────────────

  /**
   * Who is asking, and whether the class is open to them right now: in the
   * session (teacher/staff or booked student), a Cloudflare class, LIVE, and
   * before its effective end. The end sweep closes a class within seconds of
   * its end; this refuses from the very first one.
   */
  async gate(userId: string, sessionId: string): Promise<Gate> {
    const { role } = await this.live.assertInSession(userId, sessionId);
    // Being on the teacher side of the room is not the same as running it.
    const moderator = role === 'TEACHER' && (await this.live.canModerate(userId, sessionId));
    const s = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        provider: true,
        status: true,
        roomName: true,
        startsAt: true,
        durationMin: true,
        deletedAt: true,
        teacherUserId: true,
        micPolicy: true,
        cameraPolicy: true,
      },
    });
    if (!s || s.deletedAt) throw new NotFoundException('Session not found');
    if (s.provider !== 'CLOUDFLARE') {
      throw new BadRequestException({
        message: 'This class does not use the Darsly classroom',
        code: 'LIVE_WRONG_PROVIDER',
      });
    }
    const endsAt = s.startsAt.getTime() + s.durationMin * 60_000;
    if (s.status === 'ENDED' || Date.now() >= endsAt) {
      throw new BadRequestException({ message: 'انتهت هذه الجلسة', code: 'ENDED' });
    }
    if (s.status !== 'LIVE' || !s.roomName) {
      throw new BadRequestException({ message: 'لم يبدأ الفصل بعد', code: 'NOT_STARTED' });
    }
    return {
      s: {
        id: s.id,
        roomName: s.roomName,
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        teacherUserId: s.teacherUserId,
        micPolicy: s.micPolicy,
        cameraPolicy: s.cameraPolicy,
      },
      role,
      moderator,
    };
  }

  /** A participant's controls in this run — defaults when none, or when set in an earlier run. */
  private async controlsOf(sessionId: string, userId: string, run: string): Promise<Controls> {
    const c = await this.prisma.liveParticipantControl.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
      select: { roomName: true, mic: true, camera: true, cameraReport: true },
    });
    return c && c.roomName === run
      ? { mic: c.mic, camera: c.camera, cameraReport: (c.cameraReport as CameraReport | null) ?? null }
      : { ...DEFAULT_CONTROLS };
  }

  /**
   * Everyone's effective policy in a run, at once (the room state, the
   * subscribe gate and the recorder read it) — the same one function,
   * applied per student from their hand and their controls.
   */
  private async studentPolicies(sessionId: string, run: string) {
    const [s, hands, controls] = await Promise.all([
      this.prisma.liveSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { micPolicy: true, cameraPolicy: true },
      }),
      this.prisma.liveHand.findMany({ where: { sessionId, roomName: run }, select: { userId: true, state: true } }),
      this.prisma.liveParticipantControl.findMany({
        where: { sessionId, roomName: run },
        select: { userId: true, mic: true, camera: true, cameraReport: true },
      }),
    ]);
    const handOf = new Map(hands.map((h) => [h.userId, h.state]));
    const ctlOf = new Map(controls.map((c) => [c.userId, c]));
    return {
      policies: s,
      controlsOf: (userId: string): Controls => {
        const c = ctlOf.get(userId);
        return c ? { mic: c.mic, camera: c.camera, cameraReport: (c.cameraReport as CameraReport | null) ?? null } : { ...DEFAULT_CONTROLS };
      },
      of: (userId: string) =>
        effectivePolicy({
          side: 'STUDENT',
          moderator: false,
          micPolicy: s.micPolicy,
          cameraPolicy: s.cameraPolicy,
          hand: handOf.get(userId) ?? 'IDLE',
          ...(ctlOf.get(userId) ?? {}),
        }),
    };
  }

  /** This person's effective policy in this run (the one function; see classroom-policy.ts). */
  private async policyOf(g: Gate, userId: string): Promise<EffectivePolicy> {
    if (g.role !== 'STUDENT') return effectivePolicy({ side: g.role, moderator: g.moderator });
    const [hand, controls] = await Promise.all([
      this.handOf(g.s.id, userId, g.s.roomName),
      this.controlsOf(g.s.id, userId, g.s.roomName),
    ]);
    return effectivePolicy({
      side: 'STUDENT',
      moderator: false,
      micPolicy: g.s.micPolicy,
      cameraPolicy: g.s.cameraPolicy,
      hand,
      mic: controls.mic,
      camera: controls.camera,
    });
  }

  /** A student's effective policy, read fresh (for enforcing a change made by someone else). */
  private async studentPolicy(sessionId: string, run: string, userId: string): Promise<EffectivePolicy> {
    const s = await this.prisma.liveSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { micPolicy: true, cameraPolicy: true },
    });
    const [hand, controls] = await Promise.all([this.handOf(sessionId, userId, run), this.controlsOf(sessionId, userId, run)]);
    return effectivePolicy({
      side: 'STUDENT',
      moderator: false,
      micPolicy: s.micPolicy,
      cameraPolicy: s.cameraPolicy,
      hand,
      mic: controls.mic,
      camera: controls.camera,
    });
  }

  /**
   * Make what a student sends match what they may send now: every open track
   * of a kind their policy no longer allows is closed at the SFU (force), so
   * it holds whatever their browser does. Only that kind — revoking the floor
   * takes the microphone and leaves a camera they may keep. With nothing left
   * they may send, the sending connection itself is closed, as before.
   */
  async enforce(sessionId: string, run: string, userId: string, reason: string) {
    const policy = await this.studentPolicy(sessionId, run, userId);
    const sending = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId, userId, purpose: 'SEND', closedAt: null },
      select: {
        id: true,
        cfSessionId: true,
        tracks: { where: { closedAt: null }, select: { id: true, mid: true, kind: true } },
      },
    });
    if (!sending.length) return;
    if (!policy.mayOpenSend) {
      await this.cloudflare.closeConnections(
        sending.map((c) => c.id),
        reason,
      );
      return;
    }
    for (const c of sending) {
      const bad = c.tracks.filter((t) => !policy.publish[t.kind]);
      if (!bad.length) continue;
      try {
        await this.client.closeTracks(c.cfSessionId, bad.map((t) => t.mid), { force: true });
      } catch (e) {
        // The SFU would not close them: close the whole connection instead —
        // a permission must never outlive its revocation.
        this.logger.warn(`live.rtc.enforce close failed liveSession=${sessionId}: ${(e as Error).message}`);
        await this.cloudflare.closeConnections([c.id], reason);
        continue;
      }
      await this.prisma.liveRtcTrack.updateMany({
        where: { id: { in: bad.map((t) => t.id) }, closedAt: null },
        data: { closedAt: new Date() },
      });
    }
    this.logger.log(`live.rtc.enforce liveSession=${sessionId} user=${userId} reason=${reason}`);
  }

  private refuseSend(g: Gate): never {
    throw new ForbiddenException(
      g.role === 'STUDENT'
        ? { message: 'The teacher has not asked you to speak', code: 'NOT_ALLOWED_TO_SPEAK' }
        : { message: 'Only the class’s teacher can do that', code: 'NOT_A_MODERATOR' },
    );
  }

  /** The caller's own open connection in this run — or "reconnect". */
  private async connection(
    g: Gate,
    userId: string,
    connectionId: string,
    purpose?: LiveRtcPurpose,
  ) {
    const c = await this.prisma.liveRtcConnection.findFirst({
      where: {
        id: connectionId,
        sessionId: g.s.id,
        userId,
        roomName: g.s.roomName,
        closedAt: null,
        closeReason: null,
      },
    });
    if (!c || (purpose && c.purpose !== purpose)) {
      throw new ConflictException({
        message: 'The connection is no longer part of the class',
        code: 'RTC_CONNECTION_GONE',
      });
    }
    return c;
  }

  private async handOf(sessionId: string, userId: string, run: string): Promise<LiveHandState> {
    const h = await this.prisma.liveHand.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
      select: { state: true, roomName: true },
    });
    // A hand from an earlier run of the class is not a permission in this one.
    return h && h.roomName === run ? h.state : 'IDLE';
  }

  private async cf<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      throw toHttpError(e);
    }
  }

  // ── Connections ────────────────────────────────────────────────────────────

  /**
   * A new WebRTC connection (one Cloudflare SFU session).
   *
   * One per person per purpose per run: a reconnect, a refresh or a second tab
   * replaces the older one, whose published tracks are closed at the SFU — so
   * a phone that dropped and came back is never two speakers, and a stale
   * connection never keeps a permission alive.
   */
  async openConnection(userId: string, sessionId: string, purpose: LiveRtcPurpose) {
    const g = await this.gate(userId, sessionId);
    if (purpose === 'SEND' && !(await this.policyOf(g, userId)).mayOpenSend) this.refuseSend(g);
    const older = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId, userId, purpose, closedAt: null, closeReason: null },
      select: { id: true },
    });
    const cfSessionId = await this.cf(this.client.newSession());
    const row = await this.prisma.liveRtcConnection.create({
      data: {
        sessionId,
        roomName: g.s.roomName,
        userId,
        role: g.role,
        purpose,
        cfSessionId,
      },
      select: { id: true },
    });
    if (older.length) {
      await this.cloudflare.closeConnections(
        older.map((o) => o.id),
        'replaced',
      );
    }
    this.changed(sessionId);
    this.logger.log(
      `live.rtc.connect liveSession=${sessionId} user=${userId} role=${g.role} purpose=${purpose} replaced=${older.length}`,
    );
    return { connectionId: row.id };
  }

  /** The browser is done with a connection (left, or tearing down to reconnect). */
  async closeConnection(userId: string, sessionId: string, connectionId: string) {
    // No gate: closing is always allowed, including after the class ended.
    const c = await this.prisma.liveRtcConnection.findFirst({
      where: { id: connectionId, sessionId, userId, closedAt: null },
      select: { id: true },
    });
    if (c) {
      await this.cloudflare.closeConnections([c.id], 'left');
      this.changed(sessionId);
    }
    return { ok: true };
  }

  /** Everything this person had open in the class — they left. */
  async leave(userId: string, sessionId: string) {
    const open = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId, userId, closedAt: null },
      select: { id: true },
    });
    if (open.length) {
      await this.cloudflare.closeConnections(
        open.map((c) => c.id),
        'left',
      );
      this.changed(sessionId);
    }
    return { ok: true };
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  /**
   * Push tracks: the browser's offer, and what each transceiver carries.
   * Track names are the server's, so nobody can publish under someone else's.
   */
  async publish(
    userId: string,
    sessionId: string,
    connectionId: string,
    input: { offer: CfSessionDescription; tracks: { mid: string; kind: LiveTrackKind }[] },
  ) {
    const g = await this.gate(userId, sessionId);
    const c = await this.connection(g, userId, connectionId, 'SEND');
    const allowed = g.role === 'TEACHER' ? TEACHER_KINDS : STUDENT_KINDS;
    const kinds = input.tracks.map((t) => t.kind);
    if (
      !input.tracks.length ||
      kinds.some((k) => !allowed.includes(k)) ||
      new Set(kinds).size !== kinds.length ||
      new Set(input.tracks.map((t) => t.mid)).size !== input.tracks.length
    ) {
      throw new ForbiddenException({
        message: 'Not allowed to send that',
        code: 'RTC_TRACK_DENIED',
      });
    }
    const policy = await this.policyOf(g, userId);
    if (kinds.some((k) => !policy.publish[k])) this.refuseSend(g);
    const named = input.tracks.map((t) => ({
      ...t,
      trackName: `${t.kind.toLowerCase()}-${randomBytes(6).toString('hex')}`,
    }));
    const res = await this.cf(
      this.client.pushTracks(
        c.cfSessionId,
        input.offer,
        named.map((t) => ({ mid: t.mid, trackName: t.trackName })),
      ),
    );
    if (res.errorCode || res.tracks?.some((t) => t.errorCode) || !res.sessionDescription) {
      this.logger.warn(
        `live.rtc.publish rejected liveSession=${sessionId} code=${res.errorCode ?? res.tracks?.find((t) => t.errorCode)?.errorCode}`,
      );
      throw new BadRequestException({
        message: 'تعذّر الإرسال. أعد المحاولة.',
        code: 'LIVE_RTC_REJECTED',
      });
    }
    const now = new Date();
    await this.prisma.$transaction([
      // A kind is sent once per person: a restarted camera or a new screen
      // share replaces the last one rather than adding a second tile.
      this.prisma.liveRtcTrack.updateMany({
        where: {
          sessionId,
          roomName: g.s.roomName,
          userId,
          kind: { in: kinds },
          closedAt: null,
        },
        data: { closedAt: now },
      }),
      this.prisma.liveRtcTrack.createMany({
        data: named.map((t) => ({
          connectionId: c.id,
          sessionId,
          roomName: g.s.roomName,
          userId,
          kind: t.kind,
          trackName: t.trackName,
          mid: t.mid,
        })),
      }),
    ]);
    if (g.role === 'STUDENT' && kinds.includes('VIDEO')) {
      const cams = await this.prisma.liveRtcTrack.count({
        where: { sessionId, roomName: g.s.roomName, kind: 'VIDEO', closedAt: null, connection: { role: 'STUDENT', closedAt: null } },
      });
      this.logger.log(`live.camera.publish liveSession=${sessionId} user=${userId} openStudentCameras=${cams}`);
    }
    if (g.role === 'STUDENT') {
      // Revoked (or blocked) while the push was in flight: take back exactly
      // what is no longer allowed.
      const now2 = await this.studentPolicy(sessionId, g.s.roomName, userId);
      if (kinds.some((k) => !now2.publish[k])) {
        await this.enforce(sessionId, g.s.roomName, userId, 'revoked');
        this.changed(sessionId);
        this.refuseSend(g);
      }
      const hand = await this.handOf(sessionId, userId, g.s.roomName);
      if (hand === 'APPROVED_TO_SPEAK' && kinds.includes('AUDIO')) {
        await this.prisma.liveHand.updateMany({
          where: { sessionId, userId, roomName: g.s.roomName, state: 'APPROVED_TO_SPEAK' },
          data: { state: 'ACTIVE_SPEAKER' },
        });
      }
    }
    this.changed(sessionId);
    return {
      sessionDescription: res.sessionDescription,
      tracks: named.map((t) => ({ mid: t.mid, kind: t.kind })),
    };
  }

  /**
   * Pull tracks by Darsly's track id. Each must be open, in this run, not the
   * caller's own; the SFU session it comes from is read here.
   */
  async subscribe(
    userId: string,
    sessionId: string,
    connectionId: string,
    input: { trackIds: string[]; preferredRid?: string },
  ) {
    const g = await this.gate(userId, sessionId);
    const c = await this.connection(g, userId, connectionId, 'RECEIVE');
    const ids = [...new Set(input.trackIds)];
    const tracks = await this.prisma.liveRtcTrack.findMany({
      where: {
        id: { in: ids },
        sessionId,
        roomName: g.s.roomName,
        closedAt: null,
        userId: { not: userId },
        connection: { closedAt: null, closeReason: null },
      },
      select: {
        id: true,
        kind: true,
        trackName: true,
        userId: true,
        connection: { select: { cfSessionId: true, role: true } },
      },
    });
    // Privacy, enforced here and not by hiding a tile: a student's camera
    // reaches the moderators — and everyone only while that student speaks.
    if (!g.moderator && tracks.some((t) => t.kind === 'VIDEO' && t.connection.role === 'STUDENT')) {
      const pol = await this.studentPolicies(sessionId, g.s.roomName);
      const hidden = tracks.filter(
        (t) => t.kind === 'VIDEO' && t.connection.role === 'STUDENT' && pol.of(t.userId).videoAudience !== 'EVERYONE',
      );
      if (hidden.length) {
        throw new ForbiddenException({
          message: "That camera is the teacher's to see",
          code: 'RTC_TRACK_DENIED',
          denied: hidden.map((t) => t.id),
        });
      }
    }
    if (tracks.length !== ids.length) {
      const found = new Set(tracks.map((t) => t.id));
      throw new ConflictException({
        message: 'Some tracks are no longer available',
        code: 'RTC_TRACKS_GONE',
        gone: ids.filter((i) => !found.has(i)),
      });
    }
    const res = await this.cf(
      this.client.pullTracks(
        c.cfSessionId,
        tracks.map((t) => ({
          sessionId: t.connection.cfSessionId,
          trackName: t.trackName,
          // Only the teacher's camera is sent in layers.
          ...(input.preferredRid && t.kind === 'VIDEO' && t.connection.role === 'TEACHER'
            ? { preferredRid: input.preferredRid }
            : {}),
        })),
      ),
    );
    if (res.errorCode) {
      throw new BadRequestException({
        message: 'تعذّر الاستقبال. أعد المحاولة.',
        code: 'LIVE_RTC_REJECTED',
      });
    }
    const studentCams = tracks.filter((t) => t.kind === 'VIDEO' && t.connection.role === 'STUDENT').length;
    if (studentCams) {
      this.logger.log(
        `live.camera.pull liveSession=${sessionId} user=${userId} moderator=${g.moderator} studentCameras=${studentCams}`,
      );
    }
    // Cloudflare answers per track, in the order asked.
    const out = tracks.map((t, i) => {
      const r = res.tracks?.[i];
      return { trackId: t.id, kind: t.kind, mid: r?.mid ?? null, error: r?.errorCode ?? null };
    });
    return {
      requiresImmediateRenegotiation: !!res.requiresImmediateRenegotiation,
      sessionDescription: res.sessionDescription ?? null,
      tracks: out,
    };
  }

  /**
   * Pick the simulcast layer of a video this connection receives — the page
   * steps down on a weak link and back up when it recovers. The track must be
   * one this person may receive; the SFU session it comes from is read here.
   */
  async selectLayer(
    userId: string,
    sessionId: string,
    connectionId: string,
    input: { trackId: string; mid: string; rid: SimulcastRid },
  ) {
    const g = await this.gate(userId, sessionId);
    const c = await this.connection(g, userId, connectionId, 'RECEIVE');
    const t = await this.prisma.liveRtcTrack.findFirst({
      where: {
        id: input.trackId,
        sessionId,
        roomName: g.s.roomName,
        kind: 'VIDEO',
        closedAt: null,
        userId: { not: userId },
        connection: { closedAt: null, closeReason: null },
      },
      select: { trackName: true, connection: { select: { cfSessionId: true } } },
    });
    if (!t) {
      throw new ConflictException({
        message: 'Track is no longer available',
        code: 'RTC_TRACKS_GONE',
      });
    }
    await this.cf(
      this.client.selectLayer(c.cfSessionId, {
        sessionId: t.connection.cfSessionId,
        trackName: t.trackName,
        mid: input.mid,
        preferredRid: input.rid,
      }),
    );
    // Kept in the log: how often classes step down is the quality signal
    // worth watching in production.
    this.logger.log(`live.rtc.layer liveSession=${sessionId} user=${userId} rid=${input.rid}`);
    return { rid: input.rid };
  }

  async renegotiate(
    userId: string,
    sessionId: string,
    connectionId: string,
    answer: CfSessionDescription,
  ) {
    const g = await this.gate(userId, sessionId);
    const c = await this.connection(g, userId, connectionId);
    await this.cf(this.client.renegotiate(c.cfSessionId, answer));
    return { ok: true };
  }

  /**
   * Stop receiving (RECEIVE) or sending (SEND) some tracks, with the
   * browser's offer for the change; answers with the SFU's answer.
   */
  async closeTracks(
    userId: string,
    sessionId: string,
    connectionId: string,
    input: { mids: string[]; offer?: CfSessionDescription },
  ) {
    const g = await this.gate(userId, sessionId);
    const c = await this.connection(g, userId, connectionId);
    const res = await this.cf(
      this.client.closeTracks(c.cfSessionId, input.mids, {
        force: !input.offer,
        sessionDescription: input.offer,
      }),
    );
    if (c.purpose === 'SEND') {
      await this.prisma.liveRtcTrack.updateMany({
        where: { connectionId: c.id, mid: { in: input.mids }, closedAt: null },
        data: { closedAt: new Date() },
      });
      this.changed(sessionId);
    }
    return { sessionDescription: res.sessionDescription ?? null };
  }

  // ── The class as the page draws it ─────────────────────────────────────────

  async state(userId: string, sessionId: string): Promise<RtcState> {
    const g = await this.gate(userId, sessionId);
    const run = g.s.roomName;
    const since = new Date(Date.now() - PRESENCE_GRACE_SEC * 1000);
    const [tracks, present, hands, recording, capture] = await Promise.all([
      this.prisma.liveRtcTrack.findMany({
        where: {
          sessionId,
          roomName: run,
          closedAt: null,
          connection: { closedAt: null, closeReason: null },
        },
        select: { id: true, userId: true, kind: true, connection: { select: { role: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      // In the room = connected to it in this run (a lobby that fetched the
      // join answer is not in the room yet), and still heard from.
      this.prisma.liveRtcConnection
        .findMany({
          where: {
            sessionId,
            roomName: run,
            closedAt: null,
            closeReason: null,
            role: { not: 'RECORDER' },
          },
          select: { userId: true, role: true },
          distinct: ['userId'],
        })
        .then(async (conns) => {
          const fresh = await this.prisma.liveAttendance.findMany({
            where: {
              sessionId,
              userId: { in: conns.map((c) => c.userId) },
              leftAt: null,
              lastSeenAt: { gte: since },
            },
            select: { userId: true },
          });
          const alive = new Set(fresh.map((a) => a.userId));
          return conns.filter((c) => alive.has(c.userId));
        }),
      this.prisma.liveHand.findMany({
        where: { sessionId, roomName: run, state: { not: 'IDLE' } },
        select: { userId: true, state: true, raisedAt: true },
      }),
      // Everyone in the room is shown that it is being recorded.
      this.prisma.liveRecording.count({
        where: {
          sessionId,
          roomName: run,
          status: { in: ['REQUESTED', 'RECORDING', 'STOPPING'] },
          stopRequestedAt: null,
        },
      }),
      // …and that its words are being kept, when they are (OFF / MANUAL /
      // AUTO_WHEN_RECORDING, decided in one place).
      transcriptCaptureState(this.prisma, sessionId, run),
    ]);
    const roleOf = new Map<string, Role>();
    for (const p of present) roleOf.set(p.userId, p.role === 'STUDENT' ? 'STUDENT' : 'TEACHER');
    for (const t of tracks) {
      if (!roleOf.has(t.userId))
        roleOf.set(t.userId, t.connection.role === 'STUDENT' ? 'STUDENT' : 'TEACHER');
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...roleOf.keys()] } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
    const handOf = new Map(hands.map((h) => [h.userId, h.state]));
    const myHand = handOf.get(userId) ?? 'IDLE';
    const has = (uid: string, kinds: LiveTrackKind[]) =>
      tracks.some((t) => t.userId === uid && kinds.includes(t.kind));
    const myPolicy = await this.policyOf(g, userId);
    // Everyone's policy in this run: moderators see the controls; everyone
    // else sees only the cameras meant for them.
    const pol = await this.studentPolicies(sessionId, run);
    const visible = tracks.filter(
      (t) =>
        g.moderator ||
        t.userId === userId ||
        !(t.kind === 'VIDEO' && t.connection.role === 'STUDENT') ||
        pol.of(t.userId).videoAudience === 'EVERYONE',
    );
    const shown = (uid: string, kinds: LiveTrackKind[]) =>
      visible.some((t) => t.userId === uid && kinds.includes(t.kind));
    const notJoined = g.moderator ? await this.notJoined(sessionId, new Set(roleOf.keys())) : undefined;
    const bonus = await bonusTotals(this.prisma, sessionId);
    const guests = g.moderator
      ? new Set(
          (
            await this.prisma.guestBuyer.findMany({
              where: { userId: { in: [...roleOf.keys()] } },
              select: { userId: true },
            })
          ).map((x) => x.userId),
        )
      : null;
    return {
      sessionId,
      run,
      serverNow: new Date().toISOString(),
      me: {
        userId,
        role: g.role,
        hand: myHand,
        canPublish: myPolicy.mayOpenSend,
        moderator: g.moderator,
        policy: myPolicy,
        ...(g.role === 'STUDENT' ? { bonus: bonus.get(userId) ?? 0 } : {}),
      },
      maxSpeakers: maxSpeakers(),
      policies: { mic: g.s.micPolicy, camera: g.s.cameraPolicy },
      recording: recording > 0,
      transcribing: capture.active,
      transcription:
        g.role === 'TEACHER' ? { mode: capture.mode, available: capture.available } : undefined,
      participants: [...roleOf.entries()].map(([uid, role]) => ({
        userId: uid,
        name: nameOf.get(uid) ?? '',
        role,
        hand: handOf.get(uid) ?? 'IDLE',
        audio: has(uid, ['AUDIO']),
        video: shown(uid, ['VIDEO']),
        screen: has(uid, ['SCREEN']),
        ...(g.moderator && role === 'STUDENT'
          ? { controls: pol.controlsOf(uid), cameraExpected: pol.of(uid).cameraExpected }
          : {}),
        ...(g.moderator ? { bonus: bonus.get(uid) ?? 0, guest: guests!.has(uid) } : {}),
      })),
      tracks: visible.map((t) => ({
        id: t.id,
        userId: t.userId,
        kind: t.kind,
        role: t.connection.role === 'STUDENT' ? 'STUDENT' : 'TEACHER',
      })),
      ...(notJoined ? { notJoined } : {}),
    };
  }

  /** Who holds a seat (a booking, or a guest's confirmed seat) and is not in the room. */
  private async notJoined(sessionId: string, present: Set<string>) {
    const [bookings, guests] = await Promise.all([
      this.prisma.liveBooking.findMany({
        where: { sessionId },
        select: { student: { select: { userId: true, user: { select: { fullName: true } } } } },
      }),
      this.prisma.livePurchase.findMany({
        where: { sessionId, guestBuyerId: { not: null }, status: 'CONFIRMED' },
        select: { guestBuyer: { select: { userId: true, displayName: true } } },
      }),
    ]);
    const out: { userId: string; name: string; guest: boolean }[] = [];
    for (const b of bookings)
      if (!present.has(b.student.userId)) out.push({ userId: b.student.userId, name: b.student.user.fullName, guest: false });
    for (const g of guests)
      if (g.guestBuyer && !present.has(g.guestBuyer.userId))
        out.push({ userId: g.guestBuyer.userId, name: g.guestBuyer.displayName, guest: true });
    return out;
  }

  // ── Raise hand ─────────────────────────────────────────────────────────────

  /**
   * One step of the raise-hand flow. A student acts on their own hand
   * (raise/lower); the teacher on a student's (approve/reject/revoke).
   * Serialised per class with an advisory lock, so two approvals cannot both
   * take the last speaking slot and a revoke cannot cross a publish.
   */
  async hand(actorId: string, sessionId: string, action: HandAction, targetUserId?: string) {
    const g = await this.gate(actorId, sessionId);
    const run = g.s.roomName;
    let target: string;
    if (STUDENT_ACTIONS.includes(action)) {
      if (g.role !== 'STUDENT') {
        throw new ForbiddenException({
          message: 'Only a student raises a hand',
          code: 'HAND_DENIED',
        });
      }
      target = actorId;
    } else if (TEACHER_ACTIONS.includes(action)) {
      if (g.role !== 'TEACHER' || !targetUserId) {
        throw new ForbiddenException({ message: 'Only the teacher decides', code: 'HAND_DENIED' });
      }
      // On the teacher side is not enough: deciding who speaks is moderating.
      if (!g.moderator) this.refuseSend(g);
      const t = await this.live.assertInSession(targetUserId, sessionId).catch(() => null);
      if (!t || t.role !== 'STUDENT') throw new NotFoundException('Student not in this class');
      target = targetUserId;
    } else {
      throw new BadRequestException({ message: 'Unknown action', code: 'HAND_DENIED' });
    }

    const r = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-hand:${sessionId}`}))`;
      const row = await tx.liveHand.findUnique({
        where: { sessionId_userId: { sessionId, userId: target } },
      });
      const from: LiveHandState = row && row.roomName === run ? row.state : 'IDLE';
      const to = nextHandState(from, action);
      if (!to) return { ok: false as const, from };
      // Read under the lock: a policy switch (which clears hands under the
      // same lock) and a raise can never cross.
      if (action === 'raise' || action === 'approve' || action === 'invite') {
        const [sess, ctl] = await Promise.all([
          tx.liveSession.findUniqueOrThrow({ where: { id: sessionId }, select: { micPolicy: true } }),
          tx.liveParticipantControl.findUnique({
            where: { sessionId_userId: { sessionId, userId: target } },
            select: { roomName: true, mic: true },
          }),
        ]);
        const blocked = ctl?.roomName === run && ctl.mic === 'BLOCKED';
        if (blocked) return { ok: false as const, from, refused: 'MIC_BLOCKED' as const };
        if (action === 'raise' && sess.micPolicy === 'LISTEN_ONLY')
          return { ok: false as const, from, refused: 'HAND_DISABLED' as const };
      }
      if (action === 'approve' || action === 'invite') {
        const speaking = await tx.liveHand.count({
          where: {
            sessionId,
            roomName: run,
            state: { in: ['APPROVED_TO_SPEAK', 'ACTIVE_SPEAKER'] },
          },
        });
        if (speaking >= maxSpeakers()) return { ok: false as const, from, limit: true };
      }
      const now = new Date();
      const data = {
        roomName: run,
        state: to,
        ...(action === 'raise'
          ? { raisedAt: now, decidedAt: null, decidedBy: null, raisedCount: (row?.raisedCount ?? 0) + 1 }
          : {}),
        ...(TEACHER_ACTIONS.includes(action) ? { decidedAt: now, decidedBy: actorId } : {}),
      };
      await tx.liveHand.upsert({
        where: { sessionId_userId: { sessionId, userId: target } },
        create: { sessionId, userId: target, ...data },
        update: data,
      });
      return { ok: true as const, from, to };
    });
    if (!r.ok) {
      if ('refused' in r && r.refused) {
        throw new ConflictException(
          r.refused === 'MIC_BLOCKED'
            ? { message: 'The teacher has turned this microphone off for the class', code: 'MIC_BLOCKED' }
            : { message: 'Hands are off in this class — the teacher invites who speaks', code: 'HAND_DISABLED' },
        );
      }
      if ('limit' in r && r.limit) {
        throw new ConflictException({
          message: `يمكن لـ${maxSpeakers()} طلاب فقط التحدث في نفس الوقت`,
          code: 'SPEAKER_LIMIT',
          max: maxSpeakers(),
        });
      }
      throw new ConflictException({
        message: 'The hand is not in a state for that',
        code: 'HAND_STATE',
        state: r.from,
      });
    }
    // No longer allowed to speak: whatever they were sending stops at the
    // SFU now, not when their browser gets round to it.
    if (canSpeak(r.from) && !canSpeak(r.to)) await this.enforce(sessionId, run, target, 'revoked');
    // An invitation is told as one: the student's page asks them, it never switches anything on.
    this.realtime.emitToUser(target, 'live:hand', { sessionId, state: r.to, invited: action === 'invite' });
    this.changed(sessionId);
    this.logger.log(
      `live.hand liveSession=${sessionId} actor=${actorId} target=${target} ${action}: ${r.from}→${r.to}`,
    );
    return { state: r.to };
  }

  // ── The class's policies and a participant's controls ─────────────────────

  /**
   * The class's camera policy, by a moderator (the route checks academy and
   * ownership). Tightening it takes effect at once: every student camera it
   * no longer allows is closed at the SFU (OFF: all of them; SPEAKERS_ONLY:
   * all but the speakers'). Loosening it switches nothing on — students
   * choose, and under EXPECTED are asked to.
   */
  async setCameraPolicy(sessionId: string, cameraPolicy: CameraPolicy, actorId: string) {
    const s = await this.prisma.liveSession.update({
      where: { id: sessionId },
      data: { cameraPolicy },
      select: { roomName: true, status: true },
    });
    if (s.status === 'LIVE' && s.roomName) {
      const cams = await this.prisma.liveRtcTrack.findMany({
        where: { sessionId, roomName: s.roomName, kind: 'VIDEO', closedAt: null, connection: { role: 'STUDENT', closedAt: null } },
        select: { userId: true },
        distinct: ['userId'],
      });
      for (const c of cams) await this.enforce(sessionId, s.roomName, c.userId, 'policy');
      this.changed(sessionId);
    }
    this.logger.log(`live.policy liveSession=${sessionId} actor=${actorId} camera=${cameraPolicy}`);
    return { camera: cameraPolicy };
  }

  /**
   * A student's page telling the teacher why their camera is not on (denied,
   * no camera, failed) — or that it is fine again (null). Informational only:
   * shown to the teacher as reported by the device, never a reason to remove.
   */
  async reportCamera(userId: string, sessionId: string, report: CameraReport | null) {
    const g = await this.gate(userId, sessionId);
    if (g.role !== 'STUDENT') return { ok: true };
    const run = g.s.roomName;
    const cur = await this.prisma.liveParticipantControl.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    const fresh = !cur || cur.roomName !== run;
    if (fresh && report === null) return { ok: true };
    await this.prisma.liveParticipantControl.upsert({
      where: { sessionId_userId: { sessionId, userId } },
      create: { sessionId, userId, roomName: run, cameraReport: report, cameraReportAt: new Date(), updatedBy: userId },
      update: fresh
        ? { roomName: run, mic: 'DEFAULT', camera: 'DEFAULT', cameraReport: report, cameraReportAt: new Date(), updatedBy: userId }
        : { cameraReport: report, cameraReportAt: new Date() },
    });
    this.changed(sessionId);
    return { ok: true };
  }

  private readonly nudged = new Map<string, number>();
  /**
   * A moderator reminds one student to turn their camera on. A prompt on
   * their page — their click is what turns it on. At most once a minute.
   */
  async nudgeCamera(actorId: string, sessionId: string, targetUserId: string) {
    const g = await this.gate(actorId, sessionId);
    if (!g.moderator) this.refuseSend(g);
    const t = await this.live.assertInSession(targetUserId, sessionId).catch(() => null);
    if (!t || t.role !== 'STUDENT') throw new ForbiddenException({ message: 'Only a student', code: 'NOT_A_STUDENT' });
    const key = `${sessionId}:${targetUserId}`;
    const last = this.nudged.get(key) ?? 0;
    if (Date.now() - last < NUDGE_EVERY_MS) return { sent: false };
    if (this.nudged.size > 10_000) this.nudged.clear();
    this.nudged.set(key, Date.now());
    this.realtime.emitToUser(targetUserId, 'live:nudge', { sessionId, kind: 'CAMERA' });
    return { sent: true };
  }

  /**
   * The class's microphone policy, set by a moderator (the route checks the
   * academy and ownership). Switching to LISTEN_ONLY lowers every raised hand
   * of the current run — under the same lock a raise takes — and leaves who is
   * speaking alone: the teacher takes the floor back deliberately.
   */
  async setMicPolicy(sessionId: string, micPolicy: MicPolicy, actorId: string) {
    const s = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-hand:${sessionId}`}))`;
      const row = await tx.liveSession.update({
        where: { id: sessionId },
        data: { micPolicy },
        select: { roomName: true, status: true },
      });
      if (micPolicy === 'LISTEN_ONLY' && row.roomName) {
        await tx.liveHand.updateMany({
          where: { sessionId, roomName: row.roomName, state: 'HAND_RAISED' },
          data: { state: 'IDLE', decidedAt: new Date(), decidedBy: actorId },
        });
      }
      return row;
    });
    if (s.status === 'LIVE') this.changed(sessionId);
    this.logger.log(`live.policy liveSession=${sessionId} actor=${actorId} mic=${micPolicy}`);
    return { mic: micPolicy };
  }

  /**
   * One participant's controls for this run, by a moderator. A blocked
   * microphone takes the floor back (the hand is released) and closes their
   * microphone at the SFU; unblocking restores nothing by itself — they raise
   * a hand, or are invited, again. A new run starts from the defaults.
   */
  async setControls(
    actorId: string,
    sessionId: string,
    targetUserId: string,
    dto: { mic?: MicControl; camera?: CameraControl },
  ) {
    const g = await this.gate(actorId, sessionId);
    if (!g.moderator) this.refuseSend(g);
    const t = await this.live.assertInSession(targetUserId, sessionId).catch(() => null);
    if (!t || t.role !== 'STUDENT') {
      throw new ForbiddenException({ message: 'Controls apply to students', code: 'NOT_A_STUDENT' });
    }
    const run = g.s.roomName;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`live-hand:${sessionId}`}))`;
      const cur = await tx.liveParticipantControl.findUnique({
        where: { sessionId_userId: { sessionId, userId: targetUserId } },
      });
      // A control from an earlier run does not carry into this one.
      const base =
        cur && cur.roomName === run
          ? { mic: cur.mic, camera: cur.camera, cameraReport: cur.cameraReport, cameraReportAt: cur.cameraReportAt }
          : { mic: 'DEFAULT' as MicControl, camera: 'DEFAULT' as CameraControl, cameraReport: null, cameraReportAt: null };
      const next = { ...base, ...(dto.mic ? { mic: dto.mic } : {}), ...(dto.camera ? { camera: dto.camera } : {}) };
      await tx.liveParticipantControl.upsert({
        where: { sessionId_userId: { sessionId, userId: targetUserId } },
        create: { sessionId, userId: targetUserId, roomName: run, ...next, updatedBy: actorId },
        update: { roomName: run, ...next, updatedBy: actorId },
      });
      if (next.mic === 'BLOCKED') {
        await tx.liveHand.updateMany({
          where: { sessionId, userId: targetUserId, roomName: run, state: { in: ['APPROVED_TO_SPEAK', 'ACTIVE_SPEAKER'] } },
          data: { state: 'RELEASED', decidedAt: new Date(), decidedBy: actorId },
        });
        await tx.liveHand.updateMany({
          where: { sessionId, userId: targetUserId, roomName: run, state: 'HAND_RAISED' },
          data: { state: 'IDLE', decidedAt: new Date(), decidedBy: actorId },
        });
      }
    });
    await this.enforce(sessionId, run, targetUserId, 'blocked');
    this.realtime.emitToUser(targetUserId, 'live:hand', { sessionId, state: await this.handOf(sessionId, targetUserId, run) });
    this.changed(sessionId);
    this.logger.log(
      `live.controls liveSession=${sessionId} actor=${actorId} target=${targetUserId} ${JSON.stringify(dto)}`,
    );
    return this.controlsOf(sessionId, targetUserId, run);
  }

  /**
   * The teacher removes someone from the class: everything they send is
   * closed, everything they receive is closed at the SFU, and their page is
   * told to leave. As with Daily, they may come back through the join gate.
   */
  async remove(actorId: string, sessionId: string, targetUserId: string) {
    const g = await this.gate(actorId, sessionId);
    if (g.role !== 'TEACHER' || targetUserId === actorId) {
      throw new ForbiddenException({ message: 'Only the teacher decides', code: 'HAND_DENIED' });
    }
    if (!g.moderator) this.refuseSend(g);
    // The session's own teacher is never removed by staff.
    if (!(await this.live.assertInSession(targetUserId, sessionId).then((t) => t.role === 'STUDENT').catch(() => false))) {
      throw new ForbiddenException({ message: 'Only a student can be removed', code: 'NOT_A_STUDENT' });
    }
    const open = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId, userId: targetUserId, closedAt: null },
      select: { id: true, purpose: true, cfSessionId: true },
    });
    for (const c of open.filter((o) => o.purpose === 'RECEIVE')) {
      // What they pull is not in our tables; the SFU lists it.
      try {
        const st = await this.client.getSession(c.cfSessionId);
        const mids = (st.tracks ?? [])
          .filter((t) => t.mid && t.status !== 'inactive')
          .map((t) => t.mid!);
        if (mids.length) await this.client.closeTracks(c.cfSessionId, mids, { force: true });
      } catch (e) {
        this.logger.warn(`remove: could not close received tracks: ${(e as Error).message}`);
      }
    }
    await this.cloudflare.closeConnections(
      open.map((o) => o.id),
      'removed',
    );
    await this.prisma.liveHand.updateMany({
      where: { sessionId, userId: targetUserId },
      data: { state: 'IDLE' },
    });
    this.realtime.emitToUser(targetUserId, 'live:removed', { sessionId });
    this.changed(sessionId);
    this.logger.log(`live.remove liveSession=${sessionId} actor=${actorId} target=${targetUserId}`);
    return { ok: true };
  }

  // ── Telling the room ───────────────────────────────────────────────────────

  /**
   * "Something changed — read the state again." Carries no state itself: what
   * each person may see differs by role, so they read it through the gate.
   * Coalesced per class, so thirty students arriving in the same second are
   * one event, not thirty.
   */
  changed(sessionId: string) {
    if (this.pendingBroadcast.has(sessionId)) return;
    const h = setTimeout(() => {
      this.pendingBroadcast.delete(sessionId);
      this.realtime.emitToLive(sessionId, 'live:rtc-state', { sessionId });
    }, BROADCAST_COALESCE_MS);
    h.unref?.();
    this.pendingBroadcast.set(sessionId, h);
  }

  /**
   * What the recording may carry: the teacher side (camera, screen, voice)
   * and the students who may speak — never a student who only has a camera
   * on. A speaker whose floor is taken back drops out of the picture too.
   */
  async recordableTracks(sessionId: string, roomName: string) {
    const [open, pol] = await Promise.all([this.openTracks(sessionId, roomName), this.studentPolicies(sessionId, roomName)]);
    return open.filter((t) => t.connection.role !== 'STUDENT' || pol.of(t.userId).speaker);
  }

  /** For the recorder and tests: the raw open-track list of a run. */
  openTracks(sessionId: string, roomName: string) {
    return this.prisma.liveRtcTrack.findMany({
      where: {
        sessionId,
        roomName,
        closedAt: null,
        connection: { closedAt: null, closeReason: null },
      },
      select: {
        id: true,
        userId: true,
        kind: true,
        trackName: true,
        connection: { select: { cfSessionId: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
