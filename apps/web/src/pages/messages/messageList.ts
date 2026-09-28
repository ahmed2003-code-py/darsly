import type { ChatMessageDto } from '@darsly/shared-types';

/**
 * A message as the open conversation holds it: either one the server stored,
 * or one this tab is sending (or failed to send) that has no server id yet.
 *
 * A local message is keyed `local:<clientMessageId>`. When the stored copy
 * arrives — from the send's own response, from the socket, or from a poll,
 * in whatever order — it carries the same clientMessageId and replaces the
 * local one in place, so the bubble never appears twice.
 */
export type LocalMessage = ChatMessageDto & { status?: 'sending' | 'failed' };

export const localId = (clientMessageId: string) => `local:${clientMessageId}`;
export const isLocal = (m: LocalMessage) => m.id.startsWith('local:');

/** Server order: (createdAt, id). The same order the API pages in. */
function byServerOrder(a: LocalMessage, b: LocalMessage): number {
  const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Fold stored messages into what is on screen.
 *
 * - A stored message already present (same id) is replaced by the newer copy.
 * - A stored message matching a local one by clientMessageId takes its place.
 * - Local messages still in flight stay after every stored message, in the
 *   order they were written — they are the newest thing the reader did.
 */
export function mergeMessages(current: LocalMessage[], incoming: ChatMessageDto[]): LocalMessage[] {
  if (!incoming.length) return current;
  const stored = new Map<string, LocalMessage>();
  const pending: LocalMessage[] = [];
  const settled = new Set(incoming.map((m) => m.clientMessageId).filter((x): x is string => !!x));
  for (const m of current) {
    if (isLocal(m)) {
      if (!m.clientMessageId || !settled.has(m.clientMessageId)) pending.push(m);
    } else {
      stored.set(m.id, m);
    }
  }
  for (const m of incoming) stored.set(m.id, m);
  return [...[...stored.values()].sort(byServerOrder), ...pending];
}

/** The newest stored message — the cursor for catching up. */
export function newestStored(list: LocalMessage[]): LocalMessage | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (!isLocal(list[i])) return list[i];
  return undefined;
}

/** The oldest stored message — the cursor for scrolling back. */
export function oldestStored(list: LocalMessage[]): LocalMessage | undefined {
  return list.find((m) => !isLocal(m));
}

/** Mark one local message's send as failed or in flight again. */
export function setLocalStatus(
  list: LocalMessage[],
  clientMessageId: string,
  status: 'sending' | 'failed',
): LocalMessage[] {
  const id = localId(clientMessageId);
  return list.map((m) => (m.id === id ? { ...m, status } : m));
}
