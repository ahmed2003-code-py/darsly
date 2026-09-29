/**
 * The Live archive's reading logic, kept pure so it is tested without a page:
 * how chat messages group under one header, and which attendance rows the
 * card shows before "show all".
 */

export interface ArchiveMessage {
  id: string;
  body: string;
  createdAt: string;
  senderId: string;
  senderName: string;
  senderRole: string;
}

export interface MessageGroup {
  key: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  at: string;
  messages: ArchiveMessage[];
  /** A long pause came before this group — shown as a time divider. */
  pauseBefore: boolean;
}

/** Consecutive messages from one person within this gap share one header. */
export const GROUP_GAP_MS = 5 * 60_000;
/** A pause this long between messages gets a divider. */
export const PAUSE_MS = 10 * 60_000;

/** Messages (oldest first) → groups: one header per run of the same sender. */
export function groupMessages(messages: ArchiveMessage[]): MessageGroup[] {
  const out: MessageGroup[] = [];
  let lastAt = 0;
  for (const m of messages) {
    const at = new Date(m.createdAt).getTime();
    const cur = out[out.length - 1];
    const gap = lastAt ? at - lastAt : 0;
    if (cur && cur.senderId === m.senderId && gap <= GROUP_GAP_MS) {
      cur.messages.push(m);
    } else {
      out.push({
        key: m.id,
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        at: m.createdAt,
        messages: [m],
        pauseBefore: !!cur && gap >= PAUSE_MS,
      });
    }
    lastAt = at;
  }
  return out;
}

export interface AttendanceRow {
  id: string;
  userId: string;
  fullName: string;
  role: string;
  guest: boolean;
  joinedAt: string;
  leftAt: string | null;
  lastSeenAt: string;
  durationSeconds: number;
  percent: number | null;
  status: 'ATTENDED' | 'PARTIAL' | null;
  reconnects: number;
  raisedCount: number;
  spokeCount: number;
  micOpenSeconds: number;
  bonusPoints?: number;
}

export interface AttendanceReport {
  summary: {
    runSeconds: number;
    expected: number;
    joined: number;
    absent: number;
    attended: number;
    averagePercent: number | null;
    attendedThresholdSeconds: number | null;
  };
  rows: AttendanceRow[];
  absent: { userId: string; fullName: string; guest: boolean }[];
}

/**
 * The students worth a glance first: those who left early come before those
 * who stayed, then by name. Teachers are not in the student list.
 */
export function studentsByAttention(rows: AttendanceRow[]): AttendanceRow[] {
  return rows
    .filter((r) => r.role !== 'TEACHER')
    .sort(
      (a, b) =>
        (a.status === 'PARTIAL' ? 0 : 1) - (b.status === 'PARTIAL' ? 0 : 1) ||
        (a.percent ?? 0) - (b.percent ?? 0) ||
        a.fullName.localeCompare(b.fullName),
    );
}

/** The first letter to show in an avatar circle ("؟" when a name is empty). */
export const initialOf = (name: string) => name.trim().charAt(0) || '؟';
