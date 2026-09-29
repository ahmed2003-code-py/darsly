import {
  groupMessages,
  studentsByAttention,
  type ArchiveMessage,
  type AttendanceRow,
} from './liveArchive';

const at = (min: number) => new Date(Date.UTC(2026, 8, 29, 10, 0) + min * 60_000).toISOString();
const msg = (id: string, sender: string, min: number): ArchiveMessage => ({
  id,
  body: id,
  createdAt: at(min),
  senderId: sender,
  senderName: sender,
  senderRole: 'STUDENT',
});

describe('chat grouping', () => {
  it('one header for a run of the same sender; a new header when someone else speaks', () => {
    const g = groupMessages([
      msg('1', 'a', 0),
      msg('2', 'a', 1),
      msg('3', 'b', 2),
      msg('4', 'a', 3),
    ]);
    expect(g.map((x) => [x.senderId, x.messages.map((m) => m.id)])).toEqual([
      ['a', ['1', '2']],
      ['b', ['3']],
      ['a', ['4']],
    ]);
  });

  it('the same sender after a long gap starts a new group, with a pause divider', () => {
    const g = groupMessages([msg('1', 'a', 0), msg('2', 'a', 4), msg('3', 'a', 20)]);
    expect(g.map((x) => x.messages.length)).toEqual([2, 1]);
    expect(g.map((x) => x.pauseBefore)).toEqual([false, true]);
  });

  it('nothing in, nothing out', () => {
    expect(groupMessages([])).toEqual([]);
  });
});

describe('attendance ordering', () => {
  const row = (
    name: string,
    status: 'ATTENDED' | 'PARTIAL' | null,
    percent: number,
    role = 'STUDENT',
  ): AttendanceRow => ({
    id: name,
    userId: name,
    fullName: name,
    role,
    guest: false,
    joinedAt: at(0),
    leftAt: null,
    lastSeenAt: at(1),
    durationSeconds: 0,
    percent,
    status,
    reconnects: 0,
    raisedCount: 0,
    spokeCount: 0,
    micOpenSeconds: 0,
  });

  it('those who left early first, then the rest; the teacher is not a student row', () => {
    const out = studentsByAttention([
      row('z', 'ATTENDED', 100),
      row('t', null, 100, 'TEACHER'),
      row('b', 'PARTIAL', 40),
      row('a', 'PARTIAL', 10),
    ]);
    expect(out.map((r) => r.fullName)).toEqual(['a', 'b', 'z']);
  });
});
