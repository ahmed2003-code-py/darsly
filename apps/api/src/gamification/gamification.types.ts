/**
 * The event contract.
 *
 * Everything the gamification engine knows how to reward is one of these. The
 * list is deliberately about *learning outcomes* — a lesson finished, a quiz
 * passed, a course completed — and never about interface activity. There is no
 * PAGE_OPENED, no VIDEO_PLAY_PRESSED and no LESSON_STARTED reward, because
 * paying for those teaches students to generate events instead of to learn.
 */
export const GamificationEventType = {
  LESSON_COMPLETED: 'LESSON_COMPLETED',
  QUIZ_COMPLETED: 'QUIZ_COMPLETED',
  QUIZ_PASSED: 'QUIZ_PASSED',
  QUIZ_PERFECT: 'QUIZ_PERFECT',
  UNIT_COMPLETED: 'UNIT_COMPLETED',
  COURSE_COMPLETED: 'COURSE_COMPLETED',
  CERTIFICATE_EARNED: 'CERTIFICATE_EARNED',
  ASSIGNMENT_SUBMITTED: 'ASSIGNMENT_SUBMITTED',
  ASSIGNMENT_GRADED_HIGH: 'ASSIGNMENT_GRADED_HIGH',
  LIVE_ATTENDED: 'LIVE_ATTENDED',
  DAILY_LOGIN: 'DAILY_LOGIN',
  STREAK_MILESTONE: 'STREAK_MILESTONE',
  MISSION_COMPLETED: 'MISSION_COMPLETED',
  WEEKLY_QUEST_COMPLETED: 'WEEKLY_QUEST_COMPLETED',
  REVIEW_SUBMITTED: 'REVIEW_SUBMITTED',
  /** Finished a Challenge attempt — practice or ranked, any result. Pays the
   *  score the scoring engine computed (via xpOverride), every attempt,
   *  daily-capped like QUIZ_COMPLETED rather than gated per-entity. */
  CHALLENGE_COMPLETED: 'CHALLENGE_COMPLETED',
  /** Completed a RANKED challenge specifically — the "won" bonus this event
   *  type was seeded for before this feature existed. Gated per-challenge. */
  CHALLENGE_WON: 'CHALLENGE_WON',
  /** 100% accuracy on a challenge attempt — mirrors QUIZ_PERFECT. */
  CHALLENGE_PERFECT: 'CHALLENGE_PERFECT',
  LEVEL_UP: 'LEVEL_UP',
  ACHIEVEMENT_UNLOCKED: 'ACHIEVEMENT_UNLOCKED',
  REWARD_REDEEMED: 'REWARD_REDEEMED',
  /** Not a reward — a once-a-day marker for the "when do you study" counters. */
  STUDY_WINDOW: 'STUDY_WINDOW',
} as const;

export type GamificationEventType = (typeof GamificationEventType)[keyof typeof GamificationEventType];

/**
 * Which aggregate counter an event advances. Achievements are evaluated against
 * these names, so adding a counter here is what makes a new achievement
 * expressible as configuration rather than code.
 */
export const EVENT_COUNTER: Partial<Record<GamificationEventType, string>> = {
  LESSON_COMPLETED: 'lessonsCompleted',
  QUIZ_PASSED: 'quizzesPassed',
  QUIZ_PERFECT: 'perfectQuizzes',
  COURSE_COMPLETED: 'coursesCompleted',
  ASSIGNMENT_SUBMITTED: 'assignmentsDone',
  LIVE_ATTENDED: 'liveAttended',
  REVIEW_SUBMITTED: 'reviewsWritten',
  MISSION_COMPLETED: 'missionsCompleted',
  CHALLENGE_COMPLETED: 'challengesCompleted',
  CHALLENGE_WON: 'challengesWon',
  CHALLENGE_PERFECT: 'perfectChallenges',
};

export interface RecordEventInput {
  studentId: string;
  type: GamificationEventType;
  /**
   * What makes this event *this* event. Derived from the action — the lesson
   * id, the attempt id, the day — never from the request, so a retry, a
   * duplicated heartbeat and a double-tapped submit all collapse into one
   * award at the unique index.
   */
  key: string;
  tenantId?: string | null;
  courseId?: string | null;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  /** For computed awards (a scaled bonus); falls back to the configured rule. */
  xpOverride?: number;
  coinsOverride?: number;
}

export interface UnlockedAchievement {
  key: string;
  icon: string;
  titleAr: string;
  titleEn: string;
  xpReward: number;
  coinReward: number;
  titleKey: string | null;
}

export interface CompletedMission {
  id: string;
  template: string;
  kind: string;
  xpReward: number;
  coinReward: number;
}

/**
 * What actually happened, handed back to the caller so the interface can
 * celebrate it in the same round-trip that earned it. An empty outcome
 * (`awarded: false`) is the normal answer to a repeated event.
 */
export interface GamificationOutcome {
  awarded: boolean;
  xp: number;
  coins: number;
  totalXp: number;
  level: number;
  leveledUp: boolean;
  levelNameAr?: string;
  levelNameEn?: string;
  achievements: UnlockedAchievement[];
  missions: CompletedMission[];
}

export const EMPTY_OUTCOME: GamificationOutcome = {
  awarded: false,
  xp: 0,
  coins: 0,
  totalXp: 0,
  level: 1,
  leveledUp: false,
  achievements: [],
  missions: [],
};

/** Streak lengths worth telling a student about. */
export const STREAK_MILESTONES = [7, 14, 30, 60, 100, 180, 365];
