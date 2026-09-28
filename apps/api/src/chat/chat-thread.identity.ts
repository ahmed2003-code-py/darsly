import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * Who a conversation is between, as the server established it.
 *
 * Every field comes from rows the caller was just authorized against — the
 * student's profile, the teacher's profile, the academy — and never from the
 * request body. That is the whole point of the key built from it: if a client
 * could supply any part of it, it could address a conversation it has no
 * business in.
 */
export interface ThreadIdentity {
  /** The academy the conversation lives in. Today, the teacher's own workspace. */
  academyId: string;
  /** Author scope of the teacher (TeacherProfile.id); equals academyId today. */
  tenantId: string;
  studentId: string;
  /** The staff member on the other side of the conversation. */
  staffUserId: string;
}

/**
 * The conversation's identity as one string. UNIQUE in `ChatThread`.
 *
 *     <academyId>|<studentId>|S|U:<staffUserId>
 *
 * "S" is the learner-side party (the student themself); "U:" a specific staff
 * member. Messaging V2 adds "G:<guardianUserId>" and "TEAM" in those two slots
 * without changing the meaning of any key written before it.
 *
 * Must stay byte-for-byte what migration 20261019100000_chat_thread_identity
 * computes for existing rows, or a conversation from before the migration and
 * one opened after it would be two conversations with the same person.
 */
export function threadKey(i: Pick<ThreadIdentity, 'academyId' | 'studentId' | 'staffUserId'>) {
  return `${i.academyId}|${i.studentId}|S|U:${i.staffUserId}`;
}

/**
 * A cuid-shaped id for a row inserted with raw SQL, which cannot use Prisma's
 * `@default(cuid())`. Time-prefixed so ids still sort roughly by creation;
 * 64 random bits make a collision irrelevant. 25 characters, inside LIMITS.ID.
 */
export function newThreadId(): string {
  return `c${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
}

export interface ResolvedThread {
  id: string;
  tenantId: string;
  studentId: string;
  deletedAt: Date | null;
  /** true when this call inserted the row, false when it already existed */
  created: boolean;
}

/**
 * The canonical conversation for this identity: the existing one, or a new
 * one — atomically, whoever else is asking at the same moment.
 *
 * `INSERT … ON CONFLICT ("dedupeKey")` is what makes this safe, and it is the
 * database doing it rather than the application. Two requests racing for the
 * same key both try to insert; Postgres takes a lock on the unique-index entry,
 * the second blocks until the first commits, then takes the conflict branch and
 * RETURNING hands it the row the first one created. There is no window in which
 * both can see "no conversation" and both create one — which is exactly what
 * the findFirst-then-create this replaces allowed.
 *
 * `DO UPDATE SET "dedupeKey" = EXCLUDED."dedupeKey"` changes nothing; it exists
 * because `DO NOTHING` returns no row on conflict, and the caller needs the id.
 *
 * Raw SQL rather than `prisma.chatThread.upsert` on purpose: Prisma only emits
 * a native ON CONFLICT while the upsert's `where` is the unique field alone,
 * and the soft-delete middleware adds `deletedAt` to it, which silently turns
 * the upsert back into find-then-create — the race again, with no error.
 *
 * Run it inside the transaction that inserts the first message, so a message
 * that fails to save leaves no empty conversation behind.
 */
export async function resolveCanonicalThread(
  db: Prisma.TransactionClient,
  identity: ThreadIdentity,
): Promise<ResolvedThread> {
  const rows = await db.$queryRaw<ResolvedThread[]>`
    INSERT INTO "ChatThread"
      ("id", "type", "tenantId", "studentId", "academyId", "staffUserId", "dedupeKey", "createdAt", "updatedAt")
    VALUES
      (${newThreadId()}, 'DM'::"ChatThreadType", ${identity.tenantId}, ${identity.studentId},
       ${identity.academyId}, ${identity.staffUserId}, ${threadKey(identity)}, now(), now())
    ON CONFLICT ("dedupeKey") DO UPDATE SET "dedupeKey" = EXCLUDED."dedupeKey"
    RETURNING "id", "tenantId", "studentId", "deletedAt", (xmax = 0) AS "created"`;
  return rows[0];
}
