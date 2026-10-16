import type { Page } from 'puppeteer-core';
import { CloudflareRealtimeError } from '../../src/live/providers/cloudflare-realtime.client';

/**
 * A real SFU for the browser E2E, in a browser.
 *
 * The classroom's media go through Cloudflare Realtime, which the server
 * drives over HTTPS (CloudflareRealtimeClient). Here that client is replaced
 * by one with the same methods, backed by a headless Chrome page whose native
 * RTCPeerConnections answer the teachers' and students' offers, receive their
 * tracks, and forward them to whoever pulls them — real WebRTC end to end, on
 * the loopback, with no Cloudflare account and nothing leaving the machine.
 *
 * Simulcast is not received by a browser: the layers are stripped from the
 * offer it answers, and the sender falls back to one layer, as it would with
 * any peer that cannot take them.
 *
 * Like Cloudflare, it refuses to renegotiate a session whose connection is
 * not connected yet — "Session appears to be disconnected", HTTP 410 — which
 * is what a page that sent its microphone right after its camera met in
 * production (2026-10-16). Every refusal is counted (`refusedDisconnected`).
 */
const PAGE_SCRIPT = `
window.sfu = (() => {
  const S = new Map();
  const ice = (pc) => new Promise((r) => {
    if (pc.iceGatheringState === 'complete') return r();
    const f = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', f); r(); } };
    pc.addEventListener('icegatheringstatechange', f);
    setTimeout(r, 3000);
  });
  const noSimulcast = (sdp) => sdp.split('\\r\\n').filter((l) => !/^a=(simulcast|rid):/.test(l)).join('\\r\\n');
  const one = (id) => { const s = S.get(id); if (!s) throw new Error('no session ' + id); return s; };
  // One negotiation at a time per session, like the real SFU's.
  const serial = (s, fn) => { const run = s.q.then(fn, fn); s.q = run.catch(() => undefined); return run; };
  // Cloudflare's rule: a session already negotiated is renegotiated only once
  // its connection is up (a short grace for the two ends' lag).
  const connected = (s) => new Promise((r) => {
    if (!s.negotiated || s.pc.connectionState === 'connected') return r(true);
    const end = Date.now() + 2000;
    const tick = () => {
      if (s.pc.connectionState === 'connected') return r(true);
      if (Date.now() > end) return r(false);
      setTimeout(tick, 50);
    };
    tick();
  });
  const refuse = () => { const e = new Error('SESSION_DISCONNECTED'); throw e; };
  return {
    newSession(id) {
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      S.set(id, { pc, published: new Map(), tracks: new Map(), q: Promise.resolve() });
    },
    push(id, sdp, tracks) {
      const s = one(id);
      return serial(s, async () => {
        if (!(await connected(s))) refuse();
        s.negotiated = true;
        await s.pc.setRemoteDescription({ type: 'offer', sdp: noSimulcast(sdp) });
        for (const t of tracks) {
          const tr = s.pc.getTransceivers().find((x) => x.mid === t.mid);
          if (!tr) continue;
          s.published.set(t.trackName, tr.receiver.track);
          s.tracks.set(t.mid, { mid: t.mid, trackName: t.trackName, location: 'local', status: 'active' });
        }
        const a = await s.pc.createAnswer();
        await s.pc.setLocalDescription(a);
        await ice(s.pc);
        return s.pc.localDescription.sdp;
      });
    },
    pull(id, items) {
      const s = one(id);
      return serial(s, async () => {
        if (!(await connected(s))) refuse();
        s.negotiated = true;
        const trs = items.map((it) => {
          const src = S.get(it.sessionId);
          const live = src && [...src.tracks.values()].some((t) => t.trackName === it.trackName && t.status === 'active');
          const track = live ? src.published.get(it.trackName) : null;
          return track ? s.pc.addTransceiver(track, { direction: 'sendonly' }) : null;
        });
        const o = await s.pc.createOffer();
        await s.pc.setLocalDescription(o);
        await ice(s.pc);
        const mids = trs.map((t) => (t ? t.mid : null));
        mids.forEach((m, i) => { if (m) s.tracks.set(m, { mid: m, trackName: items[i].trackName, location: 'remote', status: 'active' }); });
        return { sdp: s.pc.localDescription.sdp, mids };
      });
    },
    answer(id, sdp) {
      const s = one(id);
      return serial(s, () => s.pc.setRemoteDescription({ type: 'answer', sdp }));
    },
    close(id, mids, sdp) {
      const s = one(id);
      return serial(s, async () => {
        for (const m of mids) {
          const t = s.tracks.get(m);
          if (!t) continue;
          t.status = 'inactive';
          if (t.location === 'local') s.published.delete(t.trackName);
        }
        if (!sdp) return null;
        if (!(await connected(s))) refuse();
        await s.pc.setRemoteDescription({ type: 'offer', sdp: noSimulcast(sdp) });
        const a = await s.pc.createAnswer();
        await s.pc.setLocalDescription(a);
        await ice(s.pc);
        return s.pc.localDescription.sdp;
      });
    },
    list(id) { return [...(S.get(id)?.tracks.values() ?? [])]; },
    /** Every session's connection and what it carries — for a failed test's dump. */
    diag() {
      return [...S.entries()].map(([id, s]) => ({
        id,
        connection: s.pc.connectionState,
        ice: s.pc.iceConnectionState,
        signaling: s.pc.signalingState,
        transceivers: s.pc.getTransceivers().map((t) => ({
          mid: t.mid,
          direction: t.direction,
          current: t.currentDirection,
          recv: t.receiver.track ? t.receiver.track.readyState + (t.receiver.track.muted ? '/muted' : '') : null,
          send: t.sender.track ? t.sender.track.kind + ':' + t.sender.track.readyState : null,
        })),
      }));
    },
    /** Live published tracks of a session, by kind of media. */
    published(id) {
      const s = S.get(id);
      if (!s) return [];
      return [...s.tracks.values()].filter((t) => t.location === 'local' && t.status === 'active')
        .map((t) => ({ trackName: t.trackName, kind: s.published.get(t.trackName)?.kind ?? null }));
    },
  };
})();
`;

export async function browserSfu(page: Page) {
  await page.goto('about:blank');
  await page.evaluate(PAGE_SCRIPT);
  let n = 0;
  type Sdp = { type: string; sdp: string };
  const stats = { refusedDisconnected: 0 };
  /** The page's refusal, as Cloudflare's client reports it (410 → RTC_SESSION_EXPIRED). */
  const asCloudflare = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (/SESSION_DISCONNECTED/.test(String((e as Error)?.message))) {
        stats.refusedDisconnected++;
        throw new CloudflareRealtimeError(
          'rejected',
          410,
          'session_error: Session appears to be disconnected',
        );
      }
      throw e;
    }
  };
  const client = {
    configured: true,
    turnConfigured: false,
    iceServers: async () => [],
    newSession: async () => {
      const id = `sfu${(++n).toString(36)}${Date.now().toString(36)}`;
      await page.evaluate((x) => (window as any).sfu.newSession(x), id);
      return id;
    },
    pushTracks: async (sid: string, offer: Sdp, tracks: { mid: string; trackName: string }[]) => {
      const sdp = await asCloudflare(
        page.evaluate((a, b, c) => (window as any).sfu.push(a, b, c), sid, offer.sdp, tracks),
      );
      return {
        sessionDescription: { type: 'answer', sdp },
        tracks: tracks.map((t) => ({ mid: t.mid, trackName: t.trackName })),
      };
    },
    pullTracks: async (sid: string, tracks: { sessionId: string; trackName: string }[]) => {
      const r = (await asCloudflare(
        page.evaluate(
          (a, b) => (window as any).sfu.pull(a, b),
          sid,
          tracks.map((t) => ({ sessionId: t.sessionId, trackName: t.trackName })),
        ),
      )) as { sdp: string; mids: (string | null)[] };
      return {
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: 'offer', sdp: r.sdp },
        tracks: tracks.map((t, i) =>
          r.mids[i] ? { ...t, mid: r.mids[i] } : { ...t, errorCode: 'not_found' },
        ),
      };
    },
    renegotiate: async (sid: string, answer: Sdp) => {
      await page.evaluate((a, b) => (window as any).sfu.answer(a, b), sid, answer.sdp);
      return {};
    },
    selectLayer: async () => ({ requiresImmediateRenegotiation: false }),
    closeTracks: async (
      sid: string,
      mids: string[],
      opts: { force: boolean; sessionDescription?: Sdp },
    ) => {
      const sdp = await asCloudflare(
        page.evaluate(
          (a, b, c) => (window as any).sfu.close(a, b, c),
          sid,
          mids,
          opts.sessionDescription?.sdp ?? null,
        ),
      );
      return sdp ? { sessionDescription: { type: 'answer', sdp } } : {};
    },
    getSession: async (sid: string) => ({
      tracks: await page.evaluate((a) => (window as any).sfu.list(a), sid),
    }),
  };
  /** Live published tracks at the SFU for one SFU session. */
  const published = (sid: string) =>
    page.evaluate((a) => (window as any).sfu.published(a), sid) as Promise<
      { trackName: string; kind: string | null }[]
    >;
  const diag = () => page.evaluate(() => (window as any).sfu.diag());
  return { client, published, diag, stats };
}
