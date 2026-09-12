import { Injectable } from '@nestjs/common';
import { StudentMission } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dayKey, startOfCairoDay, startOfCairoWeek, weekKey } from './period.util';
import { CompletedMission, GamificationEventType } from './gamification.types';

/**
 * Daily missions and weekly quests.
 *
 * Two decisions shape this file.
 *
 * **Generated on read, not on a schedule.** There is no cron in this codebase,
 * and adding one to hand out missions would mean every student in the database
 * gets rows written every midnight whether they open the app or not. Missions
 * are instead created the first time a student looks, which is the only moment
 * they can possibly matter.
 *
 * **Chosen from what the student actually has.** A mission to attend a live
 * session is insulting to a student whose teacher never runs one, and a mission
 * to pass a quiz is impossible in a course with no quizzes. The generator only
 * offers templates the student's own enrolments can satisfy.
 */

interface Template {
  id: string;
  kind: 'DAILY' | 'WEEKLY';
  target: number;
  xp: number;
  coins: number;
  /** Events that move this mission forward. */
  advancesOn: GamificationEventType[];
  /** Requires the student to have this kind of content available. */
  needs?: 'quiz' | 'live' | 'assignment';
}

const TEMPLATES: Template[] = [
  // ── Daily ──
  { id: 'DAILY_ONE_LESSON', kind: 'DAILY', target: 1, xp: 50, coins: 25, advancesOn: ['LESSON_COMPLETED'] },
  { id: 'DAILY_TWO_LESSONS', kind: 'DAILY', target: 2, xp: 80, coins: 40, advancesOn: ['LESSON_COMPLETED'] },
  { id: 'DAILY_PASS_QUIZ', kind: 'DAILY', target: 1, xp: 60, coins: 30, advancesOn: ['QUIZ_PASSED'], needs: 'quiz' },
  { id: 'DAILY_STRONG_QUIZ', kind: 'DAILY', target: 1, xp: 80, coins: 40, advancesOn: ['QUIZ_PERFECT'], needs: 'quiz' },
  { id: 'DAILY_ASSIGNMENT', kind: 'DAILY', target: 1, xp: 60, coins: 30, advancesOn: ['ASSIGNMENT_SUBMITTED'], needs: 'assignment' },
  { id: 'DAILY_LIVE', kind: 'DAILY', target: 1, xp: 80, coins: 40, advancesOn: ['LIVE_ATTENDED'], needs: 'live' },

  // ── Weekly quests ──
  { id: 'WEEKLY_FIVE_LESSONS', kind: 'WEEKLY', target: 5, xp: 250, coins: 100, advancesOn: ['LESSON_COMPLETED'] },
  { id: 'WEEKLY_THREE_QUIZZES', kind: 'WEEKLY', target: 3, xp: 250, coins: 100, advancesOn: ['QUIZ_PASSED'], needs: 'quiz' },
  { id: 'WEEKLY_FINISH_UNIT', kind: 'WEEKLY', target: 1, xp: 300, coins: 150, advancesOn: ['UNIT_COMPLETED'] },
  { id: 'WEEKLY_PERFECT_QUIZ', kind: 'WEEKLY', target: 1, xp: 300, coins: 150, advancesOn: ['QUIZ_PERFECT'], needs: 'quiz' },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** Stable per-student, per-day shuffle — refreshing the page must not reroll. */
function seededPick<T>(items: T[], count: number, seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const scored = items.map((item, i) => {
    let x = (h ^ Math.imul(i + 1, 2654435761)) >>> 0;
    x ^= x >>> 13;
    return { item, score: x >>> 0 };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, count).map((s) => s.item);
}

@Injectable()
export class MissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Today's missions and this week's quests, generating them if needed. */
  async current(studentId: string): Promise<StudentMission[]> {
    const today = dayKey();
    const week = weekKey();
    const existing = await this.prisma.studentMission.findMany({
      where: { studentId, OR: [{ periodKey: today }, { periodKey: week }] },
      orderBy: { createdAt: 'asc' },
    });
    const haveDaily = existing.some((m) => m.kind === 'DAILY');
    const haveWeekly = existing.some((m) => m.kind === 'WEEKLY');
    if (haveDaily && haveWeekly) return existing;

    const available = await this.availableTemplates(studentId);
    const created: StudentMission[] = [];

    if (!haveDaily) {
      const pool = available.filter((t) => t.kind === 'DAILY');
      // Never both "one lesson" and "two lessons" on the same day — the first
      // is then just a weaker copy of the second.
      const trimmed = pool.filter((t) => t.id !== 'DAILY_ONE_LESSON' || pool.length < 3);
      created.push(...(await this.createMany(studentId, seededPick(trimmed, 3, studentId + today), today)));
    }
    if (!haveWeekly) {
      const pool = available.filter((t) => t.kind === 'WEEKLY');
      created.push(...(await this.createMany(studentId, seededPick(pool, 2, studentId + week), week)));
    }
    return [...existing, ...created];
  }

  private async createMany(studentId: string, templates: Template[], periodKey: string): Promise<StudentMission[]> {
    const out: StudentMission[] = [];
    for (const t of templates) {
      // Backfill progress already made in this period, so a student who did
      // their lesson before opening the app is not asked to do it again.
      // Clamped one short of the target on purpose. Backfilled work is real,
      // but a mission that appears as "2/2" and still is not done reads as
      // broken — and paying it out on a GET would make reading the dashboard
      // award XP. Leaving exactly one step means the next lesson both completes
      // it and pays it, through the normal path.
      const prior = await this.priorProgress(studentId, t, periodKey);
      const progress = Math.min(prior, Math.max(0, t.target - 1));
      const row = await this.prisma.studentMission
        .create({
          data: {
            studentId,
            kind: t.kind,
            periodKey,
            template: t.id,
            target: t.target,
            progress,
            xpReward: t.xp,
            coinReward: t.coins,
            // Backfilled progress does not retro-pay the mission; it only
            // means the student is not starting from zero.
            completedAt: null,
          },
        })
        .catch(() => null); // raced with a parallel first load
      if (row) out.push(row);
    }
    return out;
  }

  /** Matching events already recorded inside this period. */
  private async priorProgress(studentId: string, t: Template, periodKey: string): Promise<number> {
    const since = t.kind === 'DAILY' ? startOfCairoDay(periodKey) : startOfCairoWeek();
    return this.prisma.gamificationEvent.count({
      where: { studentId, type: { in: t.advancesOn }, createdAt: { gte: since } },
    });
  }

  /** Templates this student's own enrolled content can actually satisfy. */
  private async availableTemplates(studentId: string): Promise<Template[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId, status: 'ACTIVE' },
      select: { courseId: true, tenantId: true },
    });
    if (!enrollments.length) return TEMPLATES.filter((t) => !t.needs);
    const courseIds = enrollments.map((e) => e.courseId);
    const live = { deletedAt: null, unit: { deletedAt: null, courseId: { in: courseIds } } };

    const [hasQuiz, hasAssignment, hasLive] = await Promise.all([
      this.prisma.lesson.count({ where: { ...live, type: 'QUIZ' } }),
      this.prisma.lesson.count({ where: { ...live, type: 'ASSIGNMENT' } }),
      this.prisma.liveBooking.count({
        where: { studentId, session: { startsAt: { gte: new Date() }, deletedAt: null } },
      }),
    ]);

    return TEMPLATES.filter((t) => {
      if (t.needs === 'quiz') return hasQuiz > 0;
      if (t.needs === 'assignment') return hasAssignment > 0;
      if (t.needs === 'live') return hasLive > 0;
      return true;
    });
  }

  /**
   * Advance every open mission this event feeds, and report the ones it
   * finished. The caller pays them — keeping the reward in the engine is what
   * stops a mission completion from recursing back into mission progress.
   */
  async advance(studentId: string, type: GamificationEventType): Promise<CompletedMission[]> {
    const templateIds = TEMPLATES.filter((t) => t.advancesOn.includes(type)).map((t) => t.id);
    if (!templateIds.length) return [];

    const open = await this.prisma.studentMission.findMany({
      where: {
        studentId,
        template: { in: templateIds },
        completedAt: null,
        periodKey: { in: [dayKey(), weekKey()] },
      },
    });
    if (!open.length) return [];

    const completed: CompletedMission[] = [];
    for (const m of open) {
      // Never past the target: a mission reading 3/2 is a bug the student can see.
      const progress = Math.min(m.target, m.progress + 1);
      const done = progress >= m.target;
      // Conditional update: two events arriving together cannot both see the
      // mission as incomplete and both claim the completion.
      const res = await this.prisma.studentMission.updateMany({
        where: { id: m.id, completedAt: null },
        data: { progress, ...(done ? { completedAt: new Date() } : {}) },
      });
      if (res.count && done) {
        completed.push({ id: m.id, template: m.template, kind: m.kind, xpReward: m.xpReward, coinReward: m.coinReward });
      }
    }
    return completed;
  }

  /** Labels live in the frontend dictionary; this is just the shape it needs. */
  static describe(template: string): { target: number; kind: string } | null {
    const t = BY_ID.get(template);
    return t ? { target: t.target, kind: t.kind } : null;
  }
}
