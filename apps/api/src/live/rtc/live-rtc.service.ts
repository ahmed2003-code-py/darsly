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
  };
  role: Role;
}

export interface RtcState {
  sessionId: string;
  /** This run of the class; a different value means "the class was reopened — reconnect". */
  run: string;
  serverNow: string;
  me: { userId: string; role: Role; hand: LiveHandState; canPublish: boolean };
  maxSpeakers: number;
  /** A recording of this run is being made (the REC badge). */
  recording: boolean;
  participants: {
    userId: string;
    name: string;
    role: Role;
    hand: LiveHandState;
    audio: boolean;
    video: boolean;
    screen: boolean;
  }[];
  tracks: { id: string; userId: string; kind: LiveTrackKind; role: Role }[];
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
      },
      role,
    };
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
    if (purpose === 'SEND' && g.role === 'STUDENT') {
      if (!canSpeak(await this.handOf(sessionId, userId, g.s.roomName))) {
        throw new ForbiddenException({
          message: 'The teacher has not asked you to speak',
          code: 'NOT_ALLOWED_TO_SPEAK',
        });
      }
    }
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
    if (g.role === 'STUDENT' && !canSpeak(await this.handOf(sessionId, userId, g.s.roomName))) {
      throw new ForbiddenException({
        message: 'The teacher has not asked you to speak',
        code: 'NOT_ALLOWED_TO_SPEAK',
      });
    }
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
    if (g.role === 'STUDENT') {
      // Revoked while the push was in flight: take it straight back.
      const hand = await this.handOf(sessionId, userId, g.s.roomName);
      if (!canSpeak(hand)) {
        await this.cloudflare.closeConnections([c.id], 'revoked');
        this.changed(sessionId);
        throw new ForbiddenException({
          message: 'The teacher has not asked you to speak',
          code: 'NOT_ALLOWED_TO_SPEAK',
        });
      }
      if (hand === 'APPROVED_TO_SPEAK') {
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
        connection: { select: { cfSessionId: true, role: true } },
      },
    });
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
    const [tracks, present, hands, recording] = await Promise.all([
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
    return {
      sessionId,
      run,
      serverNow: new Date().toISOString(),
      me: {
        userId,
        role: g.role,
        hand: myHand,
        canPublish: g.role === 'TEACHER' || canSpeak(myHand),
      },
      maxSpeakers: maxSpeakers(),
      recording: recording > 0,
      participants: [...roleOf.entries()].map(([uid, role]) => ({
        userId: uid,
        name: nameOf.get(uid) ?? '',
        role,
        hand: handOf.get(uid) ?? 'IDLE',
        audio: has(uid, ['AUDIO']),
        video: has(uid, ['VIDEO']),
        screen: has(uid, ['SCREEN']),
      })),
      tracks: tracks.map((t) => ({
        id: t.id,
        userId: t.userId,
        kind: t.kind,
        role: t.connection.role === 'STUDENT' ? 'STUDENT' : 'TEACHER',
      })),
    };
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
      if (action === 'approve') {
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
        ...(action === 'raise' ? { raisedAt: now, decidedAt: null, decidedBy: null } : {}),
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
    if (canSpeak(r.from) && !canSpeak(r.to)) await this.stopSending(sessionId, target, 'revoked');
    this.realtime.emitToUser(target, 'live:hand', { sessionId, state: r.to });
    this.changed(sessionId);
    this.logger.log(
      `live.hand liveSession=${sessionId} actor=${actorId} target=${target} ${action}: ${r.from}→${r.to}`,
    );
    return { state: r.to };
  }

  private async stopSending(sessionId: string, userId: string, reason: string) {
    const sending = await this.prisma.liveRtcConnection.findMany({
      where: { sessionId, userId, purpose: 'SEND', closedAt: null },
      select: { id: true },
    });
    if (sending.length) {
      await this.cloudflare.closeConnections(
        sending.map((c) => c.id),
        reason,
      );
    }
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
