import { deliverWithRetry, PieceOutbox, type UploadOwed } from './lessonAudioOutbox';
import type { PieceMeta, PieceStore } from './lessonAudioStore';

/** The browser's store, in memory: pieces and their chunks. */
function memStore() {
  const pieces = new Map<string, PieceMeta>();
  const chunks = new Map<string, Blob[]>();
  const store: PieceStore = {
    begin: async (m) => void pieces.set(m.id, m),
    append: async (id, c, at, voiced) => {
      chunks.set(id, [...(chunks.get(id) ?? []), c]);
      const m = pieces.get(id);
      if (m) pieces.set(id, { ...m, lastAt: at, voiced: m.voiced || voiced });
    },
    remove: async (id) => {
      pieces.delete(id);
      chunks.delete(id);
    },
    mark: async (id, patch) => {
      const m = pieces.get(id);
      if (m) pieces.set(id, { ...m, ...patch, id });
    },
    leftovers: async (session, exclude) =>
      [...pieces.values()]
        .filter((m) => m.session === session && !exclude.includes(m.id))
        .sort((a, b) => a.seq - b.seq)
        .map((meta) => ({ meta, blob: new Blob(chunks.get(meta.id) ?? [], { type: meta.mime }) })),
  };
  return { store, pieces };
}
const big = () => new Blob([new Uint8Array(4_000)], { type: 'audio/webm' });
const noSleep = async () => undefined;
const offline = () => {
  const e: any = new Error('Network Error');
  return e;
};
const refused = (status: number, code?: string) => ({ response: { status, data: { code } } });

async function begun(store: PieceStore, id: string, seq: number, voiced = true) {
  await store.begin({
    id,
    session: 's1',
    seq,
    mime: 'audio/webm',
    startedAt: seq * 1000,
    lastAt: seq * 1000 + 10_000,
    voiced,
    leaseId: 'L1',
  });
  await store.append(id, big(), seq * 1000 + 10_000, voiced);
}

describe('delivering a piece', () => {
  it('keeps a piece owed when the network is down, instead of giving it up', async () => {
    const r = await deliverWithRetry(
      async () => {
        throw offline();
      },
      [1, 1],
      noSleep,
    );
    expect(r).toEqual({ kind: 'failed' });
  });

  it('a timeout or a rate limit is not a refusal', async () => {
    for (const status of [408, 429, 500, 503]) {
      const r = await deliverWithRetry(
        async () => {
          throw refused(status);
        },
        [],
        noSleep,
      );
      expect(r.kind).toBe('failed');
    }
  });

  it('a 4xx is final, with its code', async () => {
    const r = await deliverWithRetry(
      async () => {
        throw refused(409, 'CAPTURE_ELSEWHERE');
      },
      [1],
      noSleep,
    );
    expect(r).toEqual({ kind: 'refused', status: 409, code: 'CAPTURE_ELSEWHERE' });
  });
});

describe('the outbox', () => {
  const make = (upload: UploadOwed) => {
    const { store, pieces } = memStore();
    const box = new PieceOutbox({ session: 's1', store, upload, waits: [1], sleep: noSleep });
    box.setLease('L1');
    return { box, store, pieces };
  };

  it('a piece that could not be sent stays owed, and goes when the connection is back', async () => {
    let online = false;
    const sent: number[] = [];
    const { box, store, pieces } = make(async (seq) => {
      if (!online) throw offline();
      sent.push(seq);
    });
    await begun(store, 's1:100', 100);
    await box.owe({ id: 's1:100', seq: 100, blob: big(), durationMs: 180_000 });
    expect(box.stats).toMatchObject({ created: 1, uploaded: 0, pending: 1, dropped: 0 });
    expect(pieces.has('s1:100')).toBe(true);
    // Reported to the manifest the moment it was made, sent or not.
    expect(box.drainReports()).toEqual([
      { seq: 100, durationMs: 180_000, state: 'QUEUED', leaseId: 'L1' },
    ]);

    online = true;
    await box.flush();
    expect(sent).toEqual([100]);
    expect(box.stats).toMatchObject({ uploaded: 1, pending: 0 });
    expect(pieces.has('s1:100')).toBe(false);
  });

  it('a refused piece is dropped — and said to be, never silently', async () => {
    const { box, store, pieces } = make(async () => {
      throw refused(409, 'CAPTURE_OFF');
    });
    await begun(store, 's1:200', 200);
    await box.owe({ id: 's1:200', seq: 200, blob: big(), durationMs: 30_000 });
    expect(box.stats).toMatchObject({ dropped: 1, pending: 0 });
    expect(pieces.has('s1:200')).toBe(false);
    expect(box.drainReports().map((r) => [r.state, r.reason])).toEqual([
      ['QUEUED', undefined],
      ['DROPPED', 'CAPTURE_OFF'],
    ]);
  });

  it('after a reload: interrupted pieces are delivered in order, silent ones reported, the live one left alone', async () => {
    const sent: { seq: number; lease?: string; ms: number }[] = [];
    const { box, store } = make(async (seq, _b, ms, _s, lease) => {
      sent.push({ seq, lease, ms });
    });
    await begun(store, 's1:300', 300);
    await begun(store, 's1:310', 310, false);
    await begun(store, 's1:290', 290);
    await begun(store, 's1:400', 400); // being recorded now
    await box.flush(['s1:400']);
    expect(sent.map((x) => x.seq)).toEqual([290, 300]);
    expect(sent.every((x) => x.lease === 'L1' && x.ms >= 10_000)).toBe(true);
    const reports = box.drainReports();
    expect(reports.filter((r) => r.state === 'SILENT').map((r) => r.seq)).toEqual([310]);
    expect(reports.filter((r) => r.state === 'QUEUED').map((r) => r.seq)).toEqual([290, 300]);
  });

  it('a piece is never sent twice at once (a flush while its first try is running)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const upload = jest.fn(async () => gate);
    const { box, store } = make(upload);
    await begun(store, 's1:500', 500);
    const first = box.owe({ id: 's1:500', seq: 500, blob: big(), durationMs: 60_000 });
    await box.flush();
    release();
    await first;
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('with no browser store, owed pieces are kept for the life of the page', async () => {
    let online = false;
    const box = new PieceOutbox({
      session: 's1',
      store: null,
      upload: async () => {
        if (!online) throw offline();
      },
      waits: [],
      sleep: noSleep,
    });
    await box.owe({ id: 's1:600', seq: 600, blob: big(), durationMs: 60_000 });
    expect(box.stats.pending).toBe(1);
    online = true;
    await box.flush();
    expect(box.stats).toMatchObject({ pending: 0, uploaded: 1 });
  });

  it('reports silence and audio health', () => {
    const box = new PieceOutbox({ session: 's1', store: null, upload: async () => undefined });
    box.setLease('L9');
    box.silent({ seq: 700, durationMs: 30_000, reason: 'NO_MICROPHONE' });
    expect(box.drainReports()).toEqual([
      { seq: 700, durationMs: 30_000, state: 'SILENT', reason: 'NO_MICROPHONE', leaseId: 'L9' },
    ]);
    box.health(false, 'AUDIO_CONTEXT_SUSPENDED');
    expect([box.audioOk, box.audioProblem]).toEqual([false, 'AUDIO_CONTEXT_SUSPENDED']);
    box.health(true);
    expect([box.audioOk, box.audioProblem]).toEqual([true, null]);
  });
});
