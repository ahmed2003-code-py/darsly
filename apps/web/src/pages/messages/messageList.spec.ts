import type { ChatMessageDto } from '@darsly/shared-types';
import {
  LocalMessage,
  localId,
  mergeMessages,
  newestStored,
  oldestStored,
  setLocalStatus,
} from './messageList';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const stored = (id: string, s: number, extra: Partial<ChatMessageDto> = {}): ChatMessageDto =>
  ({
    id,
    threadId: 't',
    senderId: 'u',
    senderName: 'U',
    senderRole: 'STUDENT',
    body: id,
    readAt: null,
    createdAt: at(s),
    ...extra,
  }) as ChatMessageDto;
const local = (cid: string, s: number): LocalMessage => ({
  ...stored(localId(cid), s),
  clientMessageId: cid,
  status: 'sending',
});
const ids = (l: LocalMessage[]) => l.map((m) => m.id);

describe('mergeMessages', () => {
  it('orders stored messages by (createdAt, id) and never duplicates one', () => {
    const page = [stored('b', 2), stored('a', 2), stored('c', 1)];
    const merged = mergeMessages(mergeMessages([], page), [stored('a', 2), stored('d', 3)]);
    expect(ids(merged)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('prepending an older page keeps everything in order', () => {
    const newest = mergeMessages([], [stored('m3', 3), stored('m4', 4)]);
    expect(ids(mergeMessages(newest, [stored('m1', 1), stored('m2', 2)]))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ]);
  });

  it('the stored copy of a send replaces its local bubble in place', () => {
    const before = mergeMessages([], [stored('m1', 1)]);
    const sending = [...before, local('cid-1', 9)];
    const after = mergeMessages(sending, [stored('m2', 2, { clientMessageId: 'cid-1' })]);
    expect(ids(after)).toEqual(['m1', 'm2']);
  });

  it('the stored copy arriving twice (socket and response) is still one bubble', () => {
    const sending = [local('cid-1', 9)];
    const echo = stored('m2', 2, { clientMessageId: 'cid-1' });
    const merged = mergeMessages(mergeMessages(sending, [echo]), [echo]);
    expect(ids(merged)).toEqual(['m2']);
  });

  it('keeps sends still in flight after every stored message', () => {
    const merged = mergeMessages([local('cid-1', 0), local('cid-2', 0)], [stored('m9', 9)]);
    expect(ids(merged)).toEqual(['m9', localId('cid-1'), localId('cid-2')]);
  });

  it('nothing incoming changes nothing', () => {
    const list = [stored('a', 1)];
    expect(mergeMessages(list, [])).toBe(list);
  });
});

describe('cursors skip local messages', () => {
  const list = mergeMessages([local('x', 0)], [stored('m1', 1), stored('m2', 2)]);
  it('newest stored', () => expect(newestStored(list)?.id).toBe('m2'));
  it('oldest stored', () => expect(oldestStored(list)?.id).toBe('m1'));
  it('none when only local', () => expect(newestStored([local('x', 0)])).toBeUndefined());
});

describe('setLocalStatus', () => {
  it('marks only the one send', () => {
    const list = [local('a', 0), local('b', 0)];
    const next = setLocalStatus(list, 'b', 'failed');
    expect(next.map((m) => m.status)).toEqual(['sending', 'failed']);
  });
});
