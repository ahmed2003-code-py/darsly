/**
 * Where the piece being recorded lives while it is recorded — so a reload, a
 * crash or a closed tab does not take up to three minutes of the lesson's
 * words with it.
 *
 * The recorder hands over a chunk every few seconds; each is kept here (the
 * browser's IndexedDB) as it arrives. A piece is removed once it has been
 * uploaded. When the teacher's page comes back, whatever is left of an
 * interrupted piece is uploaded then: its chunks joined are a valid, if
 * truncated, WebM/MP4 — the same kind of file a normal piece is.
 *
 * Browser storage can be missing or refused (private windows, blocked site
 * data): every call is wrapped, and without a store the capture works exactly
 * as before, only without this safety net.
 */

export interface PieceMeta {
  id: string;
  session: string;
  seq: number;
  mime: string;
  startedAt: number;
  lastAt: number;
  voiced: boolean;
}

export interface PieceStore {
  begin(meta: PieceMeta): Promise<void>;
  append(id: string, chunk: Blob, at: number, voiced: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  /** Pieces of this class left from an earlier page, oldest first. */
  leftovers(session: string, excludeIds: string[]): Promise<{ meta: PieceMeta; blob: Blob }[]>;
}

const DB = 'darsly-lesson-audio';
const MAX_AGE_MS = 24 * 3600_000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('pieces')) db.createObjectStore('pieces', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { autoIncrement: true }).createIndex('piece', 'piece');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const all = <T,>(req: IDBRequest<T[]>) =>
  new Promise<T[]>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** The IndexedDB store, or null where the browser has none. */
export function idbPieceStore(): PieceStore | null {
  if (typeof indexedDB === 'undefined') return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= open());
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  const removeNow = async (d: IDBDatabase, id: string) => {
    const tx = d.transaction(['pieces', 'chunks'], 'readwrite');
    tx.objectStore('pieces').delete(id);
    const idx = tx.objectStore('chunks').index('piece');
    const keys = await all(idx.getAllKeys(id));
    for (const k of keys) tx.objectStore('chunks').delete(k);
    await done(tx);
  };
  return {
    begin: (meta) =>
      safe(async () => {
        const tx = (await db()).transaction('pieces', 'readwrite');
        tx.objectStore('pieces').put(meta);
        await done(tx);
      }, undefined),
    append: (id, chunk, at, voiced) =>
      safe(async () => {
        const d = await db();
        const tx = d.transaction(['pieces', 'chunks'], 'readwrite');
        tx.objectStore('chunks').add({ piece: id, chunk, at });
        const pieces = tx.objectStore('pieces');
        const cur = await new Promise<PieceMeta | undefined>((res) => {
          const g = pieces.get(id);
          g.onsuccess = () => res(g.result as PieceMeta | undefined);
          g.onerror = () => res(undefined);
        });
        if (cur) pieces.put({ ...cur, lastAt: at, voiced: cur.voiced || voiced });
        await done(tx);
      }, undefined),
    remove: (id) => safe(async () => removeNow(await db(), id), undefined),
    leftovers: (session, excludeIds) =>
      safe(async () => {
        const d = await db();
        const metas = await all<PieceMeta>(d.transaction('pieces').objectStore('pieces').getAll());
        const out: { meta: PieceMeta; blob: Blob }[] = [];
        for (const m of metas.sort((a, b) => a.seq - b.seq)) {
          if (Date.now() - m.lastAt > MAX_AGE_MS) {
            await removeNow(d, m.id); // too old to matter to any class now
            continue;
          }
          if (m.session !== session || excludeIds.includes(m.id)) continue;
          const rows = await all<{ chunk: Blob; at: number }>(
            d.transaction('chunks').objectStore('chunks').index('piece').getAll(m.id),
          );
          out.push({ meta: m, blob: new Blob(rows.map((r) => r.chunk), { type: m.mime }) });
        }
        return out;
      }, []),
  };
}
