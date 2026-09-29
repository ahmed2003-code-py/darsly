import { randomUUID } from 'crypto';
import { AcademyService } from '../../academy/academy.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LiveScope, LiveService } from '../live.service';
import { CloudflareLiveProvider } from '../providers/cloudflare-live.provider';
import { CF_STUN } from '../providers/cloudflare-realtime.client';
import { LiveProviders } from '../providers/live-providers';
import { LiveRtcService } from '../rtc/live-rtc.service';
import { commerceStack } from '../commerce/testing';

/**
 * The Cloudflare classroom wired by hand against a real database, for the
 * Postgres integration specs of the classroom (policies, moderation, bonus,
 * admission, speaker capture). The SFU is an in-memory fake with the HTTPS
 * API's shape; everything Darsly decides runs for real, with its locks.
 */

const MIN = 60_000;

/** An in-memory SFU: sessions, tracks by mid and name, force-close. */
export function fakeSfu() {
  let n = 0;
  const sessions = new Map<
    string,
    Map<string, { mid: string; trackName: string; location: string; status: string }>
  >();
  const client = {
    configured: true,
    turnConfigured: false,
    iceServers: async () => [CF_STUN],
    newSession: async () => {
      const id = randomUUID().replace(/-/g, '') + (++n).toString(16);
      sessions.set(id, new Map());
      return id;
    },
    pushTracks: async (sid: string, _offer: unknown, tracks: { mid: string; trackName: string }[]) => {
      const s = sessions.get(sid)!;
      for (const t of tracks) s.set(t.mid, { ...t, location: 'local', status: 'active' });
      return {
        sessionDescription: { type: 'answer', sdp: 'v=0 answer' },
        tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.trackName })),
      };
    },
    pullTracks: async (sid: string, tracks: { sessionId: string; trackName: string }[]) => {
      const me = sessions.get(sid)!;
      const out = tracks.map((t) => {
        const src = [...(sessions.get(t.sessionId)?.values() ?? [])].find(
          (x) => x.trackName === t.trackName && x.status === 'active',
        );
        if (!src) return { ...t, errorCode: 'not_found' };
        const mid = String(me.size + 100);
        me.set(mid, { mid, trackName: t.trackName, location: 'remote', status: 'active' });
        return { ...t, mid };
      });
      return {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: 'v=0 offer' },
        tracks: out,
      };
    },
    renegotiate: async () => ({}),
    selectLayer: async () => ({ requiresImmediateRenegotiation: false }),
    closeTracks: async (sid: string, mids: string[]) => {
      const s = sessions.get(sid);
      for (const m of mids) {
        const t = s?.get(m);
        if (t) t.status = 'inactive';
      }
      return {};
    },
    getSession: async (sid: string) => ({ tracks: [...(sessions.get(sid)?.values() ?? [])] }),
  };
  /** Whether a publisher's track is still live at the SFU. */
  const active = (trackName: string) =>
    [...sessions.values()].some((s) =>
      [...s.values()].some((t) => t.trackName === trackName && t.location === 'local' && t.status === 'active'),
    );
  return { client, sessions, active };
}

/** The classroom services, with an SFU fake and recorded realtime events. */
export function classroom(
  prisma: PrismaService,
  opts: { gamification?: unknown; commerce?: unknown } = {},
) {
  const sfu = fakeSfu();
  const events: { to: 'user' | 'live'; id: string; event: string; payload: unknown }[] = [];
  const realtime = {
    emitToLive: (id: string, event: string, payload: unknown) => events.push({ to: 'live', id, event, payload }),
    emitToUser: (id: string, event: string, payload: unknown) => events.push({ to: 'user', id, event, payload }),
  };
  const cloudflare = new CloudflareLiveProvider(prisma, sfu.client as never);
  const providers = new LiveProviders([cloudflare], 'CLOUDFLARE');
  const live = new LiveService(
    prisma,
    { create: async () => ({}) } as never,
    (opts.gamification ?? { recordOrThrow: async () => ({}) }) as never,
    providers,
    realtime as never,
    {} as never,
    new AcademyService(prisma),
    undefined,
    undefined,
    opts.commerce as never,
  );
  const rtc = new LiveRtcService(prisma, live, cloudflare, realtime as never);
  return { sfu, events, realtime, cloudflare, live, rtc };
}

export type ClassroomWorld = Awaited<ReturnType<typeof classroomWorld>>;

/**
 * A running Cloudflare class: its teacher (the academy's owner), three booked
 * students with profiles, one outsider, and an ASSISTANT member (no grants).
 */
export async function classroomWorld(prisma: PrismaService, session: Record<string, unknown> = {}) {
  const k = randomUUID().slice(0, 8);
  const teacher = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `T ${k}`, email: `crt-${k}@it.test` },
  });
  const tp = await prisma.teacherProfile.create({ data: { userId: teacher.id, slug: `crt-${k}` } });
  await prisma.academy.create({ data: { id: tp.id, slug: `cra-${k}`, name: `A ${k}`, ownerUserId: teacher.id } });
  await prisma.academyMembership.create({
    data: { userId: teacher.id, academyId: tp.id, role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
  });
  const ls = await prisma.liveSession.create({
    data: {
      tenantId: tp.id,
      academyId: tp.id,
      teacherUserId: teacher.id,
      title: `حصة ${k}`,
      startsAt: new Date(Date.now() - 10 * MIN),
      startedAt: new Date(Date.now() - 11 * MIN),
      durationMin: 60,
      status: 'LIVE',
      provider: 'CLOUDFLARE',
      roomName: `cf-${k}-run1`,
      roomUrl: null,
      ...session,
    },
  });
  const students = [];
  const profiles = [];
  for (let i = 0; i < 4; i++) {
    const u = await prisma.user.create({
      data: { role: 'STUDENT', fullName: `S${i} ${k}`, email: `crs${i}-${k}@it.test` },
    });
    const sp = await prisma.studentProfile.create({ data: { userId: u.id } });
    if (i < 3) await prisma.liveBooking.create({ data: { sessionId: ls.id, studentId: sp.id } });
    students.push(u);
    profiles.push(sp);
  }
  const assistant = await prisma.user.create({
    data: { role: 'TEACHER', fullName: `Asst ${k}`, email: `cra-${k}@it.test` },
  });
  // A real assistant: an approved teacher identity, an ASSISTANT membership, no grants.
  await prisma.teacherProfile.create({ data: { userId: assistant.id, slug: `crasst-${k}`, status: 'APPROVED' } });
  const assistantMembership = await prisma.academyMembership.create({
    data: { userId: assistant.id, academyId: tp.id, role: 'ASSISTANT', status: 'ACTIVE', joinedAt: new Date() },
  });
  const scope: LiveScope = { academyId: tp.id, userId: teacher.id, manageAll: true, role: 'OWNER' };
  return { k, teacher, tp, ls, s: students.slice(0, 3), sp: profiles.slice(0, 3), outsider: students[3], assistant, assistantMembership, scope };
}

/**
 * A guest with a confirmed seat on a FREE class, through the real guest path
 * (a GUEST user and a GuestBuyer, no StudentProfile).
 */
export async function confirmedGuest(prisma: PrismaService, w: ClassroomWorld, name = 'ضيف تجربة') {
  const { commerce } = commerceStack(prisma);
  const { purchase } = await commerce.guestHold(w.ls.id, name);
  const row = await prisma.livePurchase.findUniqueOrThrow({ where: { id: purchase.id }, select: { guestBuyer: { select: { userId: true } } } });
  return prisma.user.findUniqueOrThrow({ where: { id: row.guestBuyer!.userId } });
}

export const OFFER = { type: 'offer' as const, sdp: 'v=0 offer' };

/** The error code a refused call carries (or 'ok'). */
export const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => e?.response?.code ?? e?.message,
  );
