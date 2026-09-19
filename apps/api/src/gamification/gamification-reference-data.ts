import { PrismaClient } from '@prisma/client';
import { GamificationEventType } from './gamification.types';

/**
 * The gamification engine's tunable config, as data.
 *
 * This is the one place these values are typed out. They were originally
 * written directly into the `20260912032358_gamification_engine` migration
 * (and, for the Challenges feature, `20260919161815_add_challenges_system` /
 * `20260919170000_challenge_achievements`) as raw SQL `INSERT`s — which is the
 * right way to seed a brand-new column on a brand-new deploy, but the wrong
 * place to keep *maintaining* config data: a migration runs exactly once, so
 * anything that later truncates these tables (the demo seed's blanket wipe,
 * a wiped local database, a fresh test database) has no way to get them back.
 *
 * `ensureGamificationReferenceData` below is that way back — idempotent,
 * upsert-based, safe to run against a brand-new database or a live one that
 * already has this data. It is called from the demo seed (so a reseed always
 * restores the whole economy, not just the demo dataset) and is exactly what
 * a future "reset gamification config to defaults" admin action would call
 * too — there is no second copy of these numbers anywhere else in the
 * codebase, and there should never be one.
 */

interface XpRuleSeed {
  id: string;
  event: GamificationEventType;
  xp: number;
  coins: number;
  dailyCap: number;
  perEntityLimit: number;
}

export const XP_RULES: XpRuleSeed[] = [
  { id: 'xpr_lesson_completed', event: 'LESSON_COMPLETED', xp: 25, coins: 10, dailyCap: 300, perEntityLimit: 1 },
  { id: 'xpr_quiz_completed', event: 'QUIZ_COMPLETED', xp: 20, coins: 5, dailyCap: 60, perEntityLimit: 0 },
  { id: 'xpr_quiz_passed', event: 'QUIZ_PASSED', xp: 30, coins: 15, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_quiz_perfect', event: 'QUIZ_PERFECT', xp: 50, coins: 25, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_unit_completed', event: 'UNIT_COMPLETED', xp: 75, coins: 30, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_course_completed', event: 'COURSE_COMPLETED', xp: 500, coins: 250, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_certificate', event: 'CERTIFICATE_EARNED', xp: 100, coins: 50, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_assignment_sub', event: 'ASSIGNMENT_SUBMITTED', xp: 25, coins: 10, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_assignment_high', event: 'ASSIGNMENT_GRADED_HIGH', xp: 40, coins: 20, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_live_attended', event: 'LIVE_ATTENDED', xp: 50, coins: 25, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_daily_login', event: 'DAILY_LOGIN', xp: 10, coins: 5, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_streak_milestone', event: 'STREAK_MILESTONE', xp: 100, coins: 50, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_mission_completed', event: 'MISSION_COMPLETED', xp: 50, coins: 25, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_quest_completed', event: 'WEEKLY_QUEST_COMPLETED', xp: 250, coins: 100, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_review_submitted', event: 'REVIEW_SUBMITTED', xp: 15, coins: 10, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_challenge_won', event: 'CHALLENGE_WON', xp: 75, coins: 40, dailyCap: 0, perEntityLimit: 0 },
  { id: 'xpr_level_up', event: 'LEVEL_UP', xp: 0, coins: 0, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_achievement', event: 'ACHIEVEMENT_UNLOCKED', xp: 0, coins: 0, dailyCap: 0, perEntityLimit: 1 },
  { id: 'xpr_reward_redeemed', event: 'REWARD_REDEEMED', xp: 0, coins: 0, dailyCap: 0, perEntityLimit: 0 },
  // Challenges (§8/§20 of the feature brief) — CHALLENGE_COMPLETED pays every
  // attempt (daily-capped, like QUIZ_COMPLETED); CHALLENGE_PERFECT mirrors
  // QUIZ_PERFECT. The real award is xpOverride from the scoring engine — see
  // ChallengesService.awardChallenge — these are only the floor defaults a
  // caller would get without one, and the row record() needs to exist at all.
  { id: 'xpr_challenge_completed', event: 'CHALLENGE_COMPLETED', xp: 20, coins: 5, dailyCap: 0, perEntityLimit: 0 },
  { id: 'xpr_challenge_perfect', event: 'CHALLENGE_PERFECT', xp: 40, coins: 20, dailyCap: 0, perEntityLimit: 1 },
];

interface LevelTierSeed {
  level: number;
  minXp: number;
  nameAr: string;
  nameEn: string;
  icon: string;
  coinReward: number;
}

export const LEVEL_TIERS: LevelTierSeed[] = [
  { level: 1, minXp: 0, nameAr: 'مبتدئ', nameEn: 'Starter', icon: 'egg', coinReward: 0 },
  { level: 2, minXp: 250, nameAr: 'مستكشف', nameEn: 'Explorer', icon: 'explore', coinReward: 25 },
  { level: 3, minXp: 600, nameAr: 'دارس', nameEn: 'Learner', icon: 'menu_book', coinReward: 50 },
  { level: 4, minXp: 1100, nameAr: 'مُنجِز', nameEn: 'Achiever', icon: 'flag', coinReward: 75 },
  { level: 5, minXp: 1800, nameAr: 'متمكّن', nameEn: 'Skilled', icon: 'psychology', coinReward: 100 },
  { level: 6, minXp: 2800, nameAr: 'متقدّم', nameEn: 'Advanced', icon: 'trending_up', coinReward: 150 },
  { level: 7, minXp: 4200, nameAr: 'خبير', nameEn: 'Expert', icon: 'workspace_premium', coinReward: 200 },
  { level: 8, minXp: 6000, nameAr: 'محترف', nameEn: 'Master', icon: 'military_tech', coinReward: 300 },
  { level: 9, minXp: 8500, nameAr: 'بطل', nameEn: 'Champion', icon: 'emoji_events', coinReward: 400 },
  { level: 10, minXp: 12000, nameAr: 'أسطورة', nameEn: 'Legend', icon: 'stars', coinReward: 600 },
];

interface AchievementSeed {
  id: string;
  key: string;
  category: string;
  icon: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  metric: string;
  threshold: number;
  xpReward: number;
  coinReward: number;
  titleKey: string | null;
  sortOrder: number;
}

export const ACHIEVEMENTS: AchievementSeed[] = [
  { id: 'ach_first_enroll', key: 'first_enroll', category: 'LEARNING', icon: 'rocket_launch', titleAr: 'أول خطوة', titleEn: 'First Step', descAr: 'اشترك في أول دورة', descEn: 'Enroll in your first course', metric: 'enrollments', threshold: 1, xpReward: 50, coinReward: 25, titleKey: null, sortOrder: 10 },
  { id: 'ach_streak_7', key: 'streak_7', category: 'CONSISTENCY', icon: 'local_fire_department', titleAr: 'مواظبة أسبوع', titleEn: 'Week Strong', descAr: 'حافظ على ٧ أيام متتالية', descEn: 'Keep a 7-day streak', metric: 'streakBest', threshold: 7, xpReward: 150, coinReward: 75, titleKey: null, sortOrder: 20 },
  { id: 'ach_dedicated', key: 'dedicated', category: 'LEARNING', icon: 'military_tech', titleAr: 'مثابر', titleEn: 'Dedicated', descAr: 'أكمِل ١٠ دروس', descEn: 'Complete 10 lessons', metric: 'lessonsCompleted', threshold: 10, xpReward: 150, coinReward: 75, titleKey: null, sortOrder: 30 },
  { id: 'ach_quiz_ace', key: 'quiz_ace', category: 'PERFORMANCE', icon: 'stars', titleAr: 'بطل الاختبارات', titleEn: 'Quiz Ace', descAr: 'احصل على ١٠٠٪ في اختبار', descEn: 'Score 100% on a quiz', metric: 'perfectQuizzes', threshold: 1, xpReward: 150, coinReward: 75, titleKey: 'quiz_master', sortOrder: 40 },
  { id: 'ach_first_certificate', key: 'first_certificate', category: 'LEARNING', icon: 'workspace_premium', titleAr: 'متخرّج', titleEn: 'Graduate', descAr: 'احصل على أول شهادة', descEn: 'Earn your first certificate', metric: 'certificates', threshold: 1, xpReward: 200, coinReward: 100, titleKey: null, sortOrder: 50 },
  { id: 'ach_scholar', key: 'scholar', category: 'LEARNING', icon: 'school', titleAr: 'عالِم', titleEn: 'Scholar', descAr: 'اجمع ٣ شهادات', descEn: 'Collect 3 certificates', metric: 'certificates', threshold: 3, xpReward: 400, coinReward: 200, titleKey: 'top_scholar', sortOrder: 60 },
  { id: 'ach_first_lesson', key: 'first_lesson', category: 'LEARNING', icon: 'play_lesson', titleAr: 'البداية', titleEn: 'Getting Started', descAr: 'أكمِل أول درس', descEn: 'Complete your first lesson', metric: 'lessonsCompleted', threshold: 1, xpReward: 50, coinReward: 25, titleKey: null, sortOrder: 5 },
  { id: 'ach_lessons_50', key: 'lessons_50', category: 'LEARNING', icon: 'auto_stories', titleAr: 'نصف المشوار', titleEn: 'Halfway There', descAr: 'أكمِل ٥٠ درسًا', descEn: 'Complete 50 lessons', metric: 'lessonsCompleted', threshold: 50, xpReward: 400, coinReward: 200, titleKey: null, sortOrder: 70 },
  { id: 'ach_lessons_100', key: 'lessons_100', category: 'LEARNING', icon: 'menu_book', titleAr: 'مئة درس', titleEn: 'Century', descAr: 'أكمِل ١٠٠ درس', descEn: 'Complete 100 lessons', metric: 'lessonsCompleted', threshold: 100, xpReward: 800, coinReward: 400, titleKey: 'knowledge_seeker', sortOrder: 80 },
  { id: 'ach_first_course', key: 'first_course', category: 'LEARNING', icon: 'verified', titleAr: 'أنهيت كورس', titleEn: 'Course Finisher', descAr: 'أكمِل كورسًا كاملًا', descEn: 'Complete a whole course', metric: 'coursesCompleted', threshold: 1, xpReward: 300, coinReward: 150, titleKey: null, sortOrder: 90 },
  { id: 'ach_courses_5', key: 'courses_5', category: 'LEARNING', icon: 'local_library', titleAr: 'خمسة كورسات', titleEn: 'Five Courses', descAr: 'أكمِل ٥ كورسات', descEn: 'Complete 5 courses', metric: 'coursesCompleted', threshold: 5, xpReward: 1000, coinReward: 500, titleKey: 'course_crusher', sortOrder: 100 },
  { id: 'ach_quiz_master', key: 'quiz_master', category: 'PERFORMANCE', icon: 'quiz', titleAr: 'سيّد الاختبارات', titleEn: 'Quiz Master', descAr: 'انجح في ٢٠ اختبارًا', descEn: 'Pass 20 quizzes', metric: 'quizzesPassed', threshold: 20, xpReward: 500, coinReward: 250, titleKey: 'quiz_master', sortOrder: 110 },
  { id: 'ach_perfect_5', key: 'perfect_5', category: 'PERFORMANCE', icon: 'grade', titleAr: 'خمس درجات كاملة', titleEn: 'Flawless Five', descAr: 'احصل على ١٠٠٪ في ٥ اختبارات', descEn: 'Score 100% on 5 quizzes', metric: 'perfectQuizzes', threshold: 5, xpReward: 500, coinReward: 250, titleKey: null, sortOrder: 120 },
  { id: 'ach_streak_30', key: 'streak_30', category: 'CONSISTENCY', icon: 'calendar_month', titleAr: 'شهر كامل', titleEn: 'Month Strong', descAr: 'حافظ على ٣٠ يومًا متتالية', descEn: 'Keep a 30-day streak', metric: 'streakBest', threshold: 30, xpReward: 600, coinReward: 300, titleKey: 'consistency_king', sortOrder: 130 },
  { id: 'ach_streak_100', key: 'streak_100', category: 'CONSISTENCY', icon: 'whatshot', titleAr: 'مئة يوم', titleEn: 'Unbreakable', descAr: 'حافظ على ١٠٠ يوم متتالية', descEn: 'Keep a 100-day streak', metric: 'streakBest', threshold: 100, xpReward: 1500, coinReward: 750, titleKey: null, sortOrder: 140 },
  { id: 'ach_top_10', key: 'top_10', category: 'COMPETITION', icon: 'leaderboard', titleAr: 'ضمن العشرة', titleEn: 'Top 10', descAr: 'ادخل أفضل ١٠ في لوحة الصدارة', descEn: 'Reach the top 10', metric: 'bestRank', threshold: 10, xpReward: 300, coinReward: 150, titleKey: null, sortOrder: 150 },
  { id: 'ach_top_3', key: 'top_3', category: 'COMPETITION', icon: 'emoji_events', titleAr: 'منصة التتويج', titleEn: 'Podium', descAr: 'ادخل أفضل ٣ في لوحة الصدارة', descEn: 'Reach the top 3', metric: 'bestRank', threshold: 3, xpReward: 600, coinReward: 300, titleKey: null, sortOrder: 160 },
  { id: 'ach_rank_1', key: 'rank_1', category: 'COMPETITION', icon: 'trophy', titleAr: 'الأول', titleEn: 'Number One', descAr: 'كن الأول في لوحة الصدارة', descEn: 'Finish first on a leaderboard', metric: 'bestRank', threshold: 1, xpReward: 1000, coinReward: 500, titleKey: 'darsly_legend', sortOrder: 170 },
  { id: 'ach_explorer_3', key: 'explorer_3', category: 'EXPLORATION', icon: 'travel_explore', titleAr: 'مستكشف', titleEn: 'Explorer', descAr: 'ابدأ في ٣ كورسات مختلفة', descEn: 'Start 3 different courses', metric: 'enrollments', threshold: 3, xpReward: 200, coinReward: 100, titleKey: null, sortOrder: 180 },
  { id: 'ach_multi_subject', key: 'multi_subject', category: 'EXPLORATION', icon: 'category', titleAr: 'متعدد المواد', titleEn: 'Well Rounded', descAr: 'تعلّم في مادتين مختلفتين', descEn: 'Learn across 2 subjects', metric: 'distinctSubjects', threshold: 2, xpReward: 250, coinReward: 125, titleKey: null, sortOrder: 190 },
  { id: 'ach_early_bird', key: 'early_bird', category: 'SPECIAL', icon: 'wb_twilight', titleAr: 'طائر الصباح', titleEn: 'Early Bird', descAr: 'ذاكر ٥ مرات قبل الثامنة صباحًا', descEn: 'Study 5 times before 8am', metric: 'earlyBirdSessions', threshold: 5, xpReward: 200, coinReward: 100, titleKey: null, sortOrder: 200 },
  { id: 'ach_night_owl', key: 'night_owl', category: 'SPECIAL', icon: 'bedtime', titleAr: 'بومة الليل', titleEn: 'Night Owl', descAr: 'ذاكر ٥ مرات بعد منتصف الليل', descEn: 'Study 5 times after midnight', metric: 'nightOwlSessions', threshold: 5, xpReward: 200, coinReward: 100, titleKey: null, sortOrder: 210 },
  { id: 'ach_weekend_warrior', key: 'weekend_warrior', category: 'SPECIAL', icon: 'weekend', titleAr: 'محارب الإجازة', titleEn: 'Weekend Warrior', descAr: 'ذاكر في ٥ عطلات', descEn: 'Study on 5 weekends', metric: 'weekendSessions', threshold: 5, xpReward: 200, coinReward: 100, titleKey: 'speed_solver', sortOrder: 220 },
  { id: 'ach_assignments_10', key: 'assignments_10', category: 'LEARNING', icon: 'assignment_turned_in', titleAr: 'ملتزم بالواجبات', titleEn: 'On Top of It', descAr: 'سلّم ١٠ واجبات', descEn: 'Submit 10 assignments', metric: 'assignmentsDone', threshold: 10, xpReward: 300, coinReward: 150, titleKey: null, sortOrder: 230 },
  { id: 'ach_live_5', key: 'live_5', category: 'LEARNING', icon: 'sensors', titleAr: 'حاضر دائمًا', titleEn: 'Always There', descAr: 'احضر ٥ جلسات مباشرة', descEn: 'Attend 5 live sessions', metric: 'liveAttended', threshold: 5, xpReward: 300, coinReward: 150, titleKey: null, sortOrder: 240 },
  // Challenges (§20-21 of the feature brief) — a first, deliberately small set.
  // More can be added later as plain rows; the achievement engine is entirely
  // DB-driven (see AchievementsService), so that needs no code change.
  { id: 'ach_challenge_first', key: 'challenge_first', category: 'LEARNING', icon: 'bolt', titleAr: 'أول تحدي', titleEn: 'First Challenge', descAr: 'أكمِل أول تحدي', descEn: 'Complete your first Challenge', metric: 'challengesCompleted', threshold: 1, xpReward: 75, coinReward: 40, titleKey: null, sortOrder: 200 },
  { id: 'ach_challenge_ace', key: 'challenge_ace', category: 'PERFORMANCE', icon: 'stars', titleAr: 'بطل التحديات', titleEn: 'Challenge Ace', descAr: 'احصل على درجة كاملة في تحدي', descEn: 'Score a perfect challenge', metric: 'perfectChallenges', threshold: 1, xpReward: 150, coinReward: 75, titleKey: null, sortOrder: 210 },
  { id: 'ach_challenge_ranked_10', key: 'challenge_ranked_10', category: 'COMPETITION', icon: 'military_tech', titleAr: 'محارب التحديات', titleEn: 'Challenge Warrior', descAr: 'أنهِ ١٠ تحديات تنافسية', descEn: 'Finish 10 ranked Challenges', metric: 'challengesWon', threshold: 10, xpReward: 400, coinReward: 200, titleKey: null, sortOrder: 220 },
];

interface TitleSeed {
  key: string;
  labelAr: string;
  labelEn: string;
  icon: string;
  sortOrder: number;
}

export const TITLES: TitleSeed[] = [
  { key: 'quiz_master', labelAr: 'بطل الاختبارات', labelEn: 'Quiz Master', icon: 'stars', sortOrder: 10 },
  { key: 'course_crusher', labelAr: 'قاهر الكورسات', labelEn: 'Course Crusher', icon: 'local_fire_department', sortOrder: 20 },
  { key: 'knowledge_seeker', labelAr: 'باحث عن المعرفة', labelEn: 'Knowledge Seeker', icon: 'travel_explore', sortOrder: 30 },
  { key: 'consistency_king', labelAr: 'ملك المواظبة', labelEn: 'Consistency King', icon: 'calendar_month', sortOrder: 40 },
  { key: 'top_scholar', labelAr: 'الطالب الأول', labelEn: 'Top Scholar', icon: 'school', sortOrder: 50 },
  { key: 'speed_solver', labelAr: 'سريع الحل', labelEn: 'Speed Solver', icon: 'bolt', sortOrder: 60 },
  { key: 'darsly_legend', labelAr: 'أسطورة درسلي', labelEn: 'Darsly Legend', icon: 'auto_awesome', sortOrder: 70 },
];

interface RewardSeed {
  id: string;
  key: string;
  category: string;
  kind: string;
  icon: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  costCoins: number;
  payload: Record<string, unknown>;
  sortOrder: number;
}

export const REWARDS: RewardSeed[] = [
  { id: 'rwd_streak_freeze', key: 'streak_freeze', category: 'PROGRESS', kind: 'STREAK_FREEZE', icon: 'ac_unit', titleAr: 'تجميد السلسلة', titleEn: 'Streak Freeze', descAr: 'يحمي سلسلتك ليوم واحد لو فاتك المذاكرة', descEn: 'Protects your streak for one missed day', costCoins: 150, payload: { count: 1 }, sortOrder: 10 },
  { id: 'rwd_xp_boost_2x', key: 'xp_boost_2x', category: 'PROGRESS', kind: 'XP_BOOST', icon: 'bolt', titleAr: 'مضاعفة النقاط ×٢', titleEn: '2× XP Boost', descAr: 'ضاعِف نقاط أول ٣ دروس تكمّلها', descEn: 'Doubles the XP of your next 3 lessons', costCoins: 300, payload: { multiplier: 2, lessons: 3 }, sortOrder: 20 },
  { id: 'rwd_xp_boost_15', key: 'xp_boost_15', category: 'PROGRESS', kind: 'XP_BOOST', icon: 'trending_up', titleAr: 'مضاعفة النقاط ×١.٥', titleEn: '1.5× XP Boost', descAr: 'زوّد نقاط أول ٥ دروس بنسبة ٥٠٪', descEn: '+50% XP on your next 5 lessons', costCoins: 180, payload: { multiplier: 1.5, lessons: 5 }, sortOrder: 30 },
  { id: 'rwd_title_seeker', key: 'title_knowledge_seeker', category: 'PROFILE', kind: 'TITLE', icon: 'travel_explore', titleAr: 'لقب: باحث عن المعرفة', titleEn: 'Title: Knowledge Seeker', descAr: 'أضف اللقب لملفك الشخصي', descEn: 'Unlock this title for your profile', costCoins: 400, payload: { titleKey: 'knowledge_seeker' }, sortOrder: 40 },
  { id: 'rwd_title_speed', key: 'title_speed_solver', category: 'PROFILE', kind: 'TITLE', icon: 'bolt', titleAr: 'لقب: سريع الحل', titleEn: 'Title: Speed Solver', descAr: 'أضف اللقب لملفك الشخصي', descEn: 'Unlock this title for your profile', costCoins: 400, payload: { titleKey: 'speed_solver' }, sortOrder: 50 },
];

/**
 * Restore the full gamification config. Idempotent — upserts every row by its
 * natural unique key (event / level / key), so running this against a fresh
 * database, a partially-populated one, or one that already has all of it
 * produces the exact same end state every time. Safe to call as often as you
 * like; it only ever brings rows up to these values, never touches anything
 * else (a student's own XP/coins/achievements are untouched).
 */
export async function ensureGamificationReferenceData(prisma: PrismaClient): Promise<void> {
  for (const r of XP_RULES) {
    await prisma.xpRule.upsert({
      where: { event: r.event },
      update: { xp: r.xp, coins: r.coins, dailyCap: r.dailyCap, perEntityLimit: r.perEntityLimit, isActive: true },
      create: { id: r.id, event: r.event, xp: r.xp, coins: r.coins, dailyCap: r.dailyCap, perEntityLimit: r.perEntityLimit },
    });
  }

  for (const t of LEVEL_TIERS) {
    await prisma.levelTier.upsert({
      where: { level: t.level },
      update: { minXp: t.minXp, nameAr: t.nameAr, nameEn: t.nameEn, icon: t.icon, coinReward: t.coinReward },
      create: t,
    });
  }

  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { key: a.key },
      update: {
        category: a.category, icon: a.icon, titleAr: a.titleAr, titleEn: a.titleEn,
        descAr: a.descAr, descEn: a.descEn, metric: a.metric, threshold: a.threshold,
        xpReward: a.xpReward, coinReward: a.coinReward, titleKey: a.titleKey,
        isActive: true, sortOrder: a.sortOrder,
      },
      create: { ...a, isActive: true },
    });
  }

  for (const t of TITLES) {
    await prisma.title.upsert({
      where: { key: t.key },
      update: { labelAr: t.labelAr, labelEn: t.labelEn, icon: t.icon, sortOrder: t.sortOrder },
      create: t,
    });
  }

  for (const r of REWARDS) {
    await prisma.reward.upsert({
      where: { key: r.key },
      update: {
        category: r.category, kind: r.kind, icon: r.icon, titleAr: r.titleAr, titleEn: r.titleEn,
        descAr: r.descAr, descEn: r.descEn, costCoins: r.costCoins, payload: r.payload as never,
        isActive: true, sortOrder: r.sortOrder,
      },
      create: { ...r, payload: r.payload as never, isActive: true },
    });
  }
}
