-- CreateTable
CREATE TABLE IF NOT EXISTS "StudentGamification" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "coinsEarned" INTEGER NOT NULL DEFAULT 0,
    "coinsSpent" INTEGER NOT NULL DEFAULT 0,
    "lessonsCompleted" INTEGER NOT NULL DEFAULT 0,
    "quizzesPassed" INTEGER NOT NULL DEFAULT 0,
    "perfectQuizzes" INTEGER NOT NULL DEFAULT 0,
    "coursesCompleted" INTEGER NOT NULL DEFAULT 0,
    "assignmentsDone" INTEGER NOT NULL DEFAULT 0,
    "liveAttended" INTEGER NOT NULL DEFAULT 0,
    "reviewsWritten" INTEGER NOT NULL DEFAULT 0,
    "missionsCompleted" INTEGER NOT NULL DEFAULT 0,
    "earlyBirdSessions" INTEGER NOT NULL DEFAULT 0,
    "nightOwlSessions" INTEGER NOT NULL DEFAULT 0,
    "weekendSessions" INTEGER NOT NULL DEFAULT 0,
    "streakFreezes" INTEGER NOT NULL DEFAULT 0,
    "freezeUsedOn" TIMESTAMP(3),
    "activeTitle" TEXT,
    "bestRank" INTEGER,
    "lastLevelUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentGamification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "GamificationEvent" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "tenantId" TEXT,
    "courseId" TEXT,
    "type" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "coinsAwarded" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "XpRule" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "coins" INTEGER NOT NULL DEFAULT 0,
    "dailyCap" INTEGER NOT NULL DEFAULT 0,
    "perEntityLimit" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XpRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LevelTier" (
    "level" INTEGER NOT NULL,
    "minXp" INTEGER NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'military_tech',
    "coinReward" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LevelTier_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Achievement" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "descAr" TEXT NOT NULL,
    "descEn" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "coinReward" INTEGER NOT NULL DEFAULT 0,
    "titleKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StudentAchievement" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Title" (
    "key" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'workspace_premium',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Title_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StudentTitle" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StudentMission" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "xpReward" INTEGER NOT NULL DEFAULT 0,
    "coinReward" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Reward" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "tenantId" TEXT,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "descAr" TEXT NOT NULL DEFAULT '',
    "descEn" TEXT NOT NULL DEFAULT '',
    "costCoins" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "stock" INTEGER,
    "needsApproval" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RewardRedemption" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "costCoins" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FULFILLED',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StudentGamification_studentId_key" ON "StudentGamification"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "GamificationEvent_idempotencyKey_key" ON "GamificationEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GamificationEvent_studentId_createdAt_idx" ON "GamificationEvent"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GamificationEvent_studentId_type_idx" ON "GamificationEvent"("studentId", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GamificationEvent_tenantId_createdAt_idx" ON "GamificationEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GamificationEvent_type_createdAt_idx" ON "GamificationEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "XpRule_event_key" ON "XpRule"("event");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Achievement_key_key" ON "Achievement"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StudentAchievement_studentId_unlockedAt_idx" ON "StudentAchievement"("studentId", "unlockedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StudentAchievement_studentId_achievementId_key" ON "StudentAchievement"("studentId", "achievementId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StudentTitle_studentId_titleKey_key" ON "StudentTitle"("studentId", "titleKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StudentMission_studentId_kind_periodKey_idx" ON "StudentMission"("studentId", "kind", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StudentMission_studentId_periodKey_template_key" ON "StudentMission"("studentId", "periodKey", "template");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LeaderboardEntry_scope_scopeId_period_periodKey_xp_idx" ON "LeaderboardEntry"("scope", "scopeId", "period", "periodKey", "xp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LeaderboardEntry_scope_scopeId_period_periodKey_studentId_key" ON "LeaderboardEntry"("scope", "scopeId", "period", "periodKey", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Reward_key_key" ON "Reward"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Reward_tenantId_isActive_idx" ON "Reward"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RewardRedemption_studentId_createdAt_idx" ON "RewardRedemption"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RewardRedemption_status_createdAt_idx" ON "RewardRedemption"("status", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentGamification" ADD CONSTRAINT "StudentGamification_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "GamificationEvent" ADD CONSTRAINT "GamificationEvent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentAchievement" ADD CONSTRAINT "StudentAchievement_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentAchievement" ADD CONSTRAINT "StudentAchievement_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "Achievement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentTitle" ADD CONSTRAINT "StudentTitle_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentTitle" ADD CONSTRAINT "StudentTitle_titleKey_fkey" FOREIGN KEY ("titleKey") REFERENCES "Title"("key") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StudentMission" ADD CONSTRAINT "StudentMission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the default economy.
--
-- Config lives in the database so it can be tuned without a deploy, but it has
-- to work the moment the table exists — an empty XpRule table is a platform
-- where learning earns nothing. Ids are explicit and readable so re-running
-- this is a no-op rather than a second copy.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "XpRule" ("id", "event", "xp", "coins", "dailyCap", "perEntityLimit", "isActive", "updatedAt") VALUES
  ('xpr_lesson_completed',    'LESSON_COMPLETED',        25,  10,  300, 1, true, NOW()),
  ('xpr_quiz_completed',      'QUIZ_COMPLETED',          20,   5,   60, 0, true, NOW()),
  ('xpr_quiz_passed',         'QUIZ_PASSED',             30,  15,    0, 1, true, NOW()),
  ('xpr_quiz_perfect',        'QUIZ_PERFECT',            50,  25,    0, 1, true, NOW()),
  ('xpr_unit_completed',      'UNIT_COMPLETED',          75,  30,    0, 1, true, NOW()),
  ('xpr_course_completed',    'COURSE_COMPLETED',       500, 250,    0, 1, true, NOW()),
  ('xpr_certificate',         'CERTIFICATE_EARNED',     100,  50,    0, 1, true, NOW()),
  ('xpr_assignment_sub',      'ASSIGNMENT_SUBMITTED',    25,  10,    0, 1, true, NOW()),
  ('xpr_assignment_high',     'ASSIGNMENT_GRADED_HIGH',  40,  20,    0, 1, true, NOW()),
  ('xpr_live_attended',       'LIVE_ATTENDED',           50,  25,    0, 1, true, NOW()),
  ('xpr_daily_login',         'DAILY_LOGIN',             10,   5,    0, 1, true, NOW()),
  ('xpr_streak_milestone',    'STREAK_MILESTONE',       100,  50,    0, 1, true, NOW()),
  ('xpr_mission_completed',   'MISSION_COMPLETED',       50,  25,    0, 1, true, NOW()),
  ('xpr_quest_completed',     'WEEKLY_QUEST_COMPLETED',  250, 100,   0, 1, true, NOW()),
  ('xpr_review_submitted',    'REVIEW_SUBMITTED',        15,  10,    0, 1, true, NOW()),
  ('xpr_challenge_won',       'CHALLENGE_WON',           75,  40,    0, 0, true, NOW()),
  ('xpr_level_up',            'LEVEL_UP',                 0,   0,    0, 1, true, NOW()),
  ('xpr_achievement',         'ACHIEVEMENT_UNLOCKED',     0,   0,    0, 1, true, NOW()),
  ('xpr_reward_redeemed',     'REWARD_REDEEMED',          0,   0,    0, 0, true, NOW())
ON CONFLICT ("event") DO NOTHING;

INSERT INTO "LevelTier" ("level", "minXp", "nameAr", "nameEn", "icon", "coinReward") VALUES
  (1,     0, 'مبتدئ',   'Starter',  'egg',              0),
  (2,   250, 'مستكشف',  'Explorer', 'explore',         25),
  (3,   600, 'دارس',    'Learner',  'menu_book',       50),
  (4,  1100, 'مُنجِز',   'Achiever', 'flag',            75),
  (5,  1800, 'متمكّن',   'Skilled',  'psychology',     100),
  (6,  2800, 'متقدّم',   'Advanced', 'trending_up',    150),
  (7,  4200, 'خبير',    'Expert',   'workspace_premium', 200),
  (8,  6000, 'محترف',   'Master',   'military_tech',  300),
  (9,  8500, 'بطل',     'Champion', 'emoji_events',   400),
  (10,12000, 'أسطورة',  'Legend',   'stars',          600)
ON CONFLICT ("level") DO NOTHING;

INSERT INTO "Title" ("key", "labelAr", "labelEn", "icon", "sortOrder") VALUES
  ('quiz_master',       'بطل الاختبارات',  'Quiz Master',      'stars',              10),
  ('course_crusher',    'قاهر الكورسات',   'Course Crusher',   'local_fire_department', 20),
  ('knowledge_seeker',  'باحث عن المعرفة', 'Knowledge Seeker', 'travel_explore',     30),
  ('consistency_king',  'ملك المواظبة',    'Consistency King', 'calendar_month',     40),
  ('top_scholar',       'الطالب الأول',    'Top Scholar',      'school',             50),
  ('speed_solver',      'سريع الحل',       'Speed Solver',     'bolt',               60),
  ('darsly_legend',     'أسطورة درسلي',    'Darsly Legend',    'auto_awesome',       70)
ON CONFLICT ("key") DO NOTHING;

-- Achievements. The first six keys are the badges the platform already had
-- (student-extras.service.ts) — same keys, same thresholds, so no student wakes
-- up having "lost" a badge they earned.
INSERT INTO "Achievement" ("id","key","category","icon","titleAr","titleEn","descAr","descEn","metric","threshold","xpReward","coinReward","titleKey","isActive","sortOrder") VALUES
  ('ach_first_enroll','first_enroll','LEARNING','rocket_launch','أول خطوة','First Step','اشترك في أول دورة','Enroll in your first course','enrollments',1,50,25,NULL,true,10),
  ('ach_streak_7','streak_7','CONSISTENCY','local_fire_department','مواظبة أسبوع','Week Strong','حافظ على ٧ أيام متتالية','Keep a 7-day streak','streakBest',7,150,75,NULL,true,20),
  ('ach_dedicated','dedicated','LEARNING','military_tech','مثابر','Dedicated','أكمِل ١٠ دروس','Complete 10 lessons','lessonsCompleted',10,150,75,NULL,true,30),
  ('ach_quiz_ace','quiz_ace','PERFORMANCE','stars','بطل الاختبارات','Quiz Ace','احصل على ١٠٠٪ في اختبار','Score 100% on a quiz','perfectQuizzes',1,150,75,'quiz_master',true,40),
  ('ach_first_certificate','first_certificate','LEARNING','workspace_premium','متخرّج','Graduate','احصل على أول شهادة','Earn your first certificate','certificates',1,200,100,NULL,true,50),
  ('ach_scholar','scholar','LEARNING','school','عالِم','Scholar','اجمع ٣ شهادات','Collect 3 certificates','certificates',3,400,200,'top_scholar',true,60),
  ('ach_first_lesson','first_lesson','LEARNING','play_lesson','البداية','Getting Started','أكمِل أول درس','Complete your first lesson','lessonsCompleted',1,50,25,NULL,true,5),
  ('ach_lessons_50','lessons_50','LEARNING','auto_stories','نصف المشوار','Halfway There','أكمِل ٥٠ درسًا','Complete 50 lessons','lessonsCompleted',50,400,200,NULL,true,70),
  ('ach_lessons_100','lessons_100','LEARNING','menu_book','مئة درس','Century','أكمِل ١٠٠ درس','Complete 100 lessons','lessonsCompleted',100,800,400,'knowledge_seeker',true,80),
  ('ach_first_course','first_course','LEARNING','verified','أنهيت كورس','Course Finisher','أكمِل كورسًا كاملًا','Complete a whole course','coursesCompleted',1,300,150,NULL,true,90),
  ('ach_courses_5','courses_5','LEARNING','local_library','خمسة كورسات','Five Courses','أكمِل ٥ كورسات','Complete 5 courses','coursesCompleted',5,1000,500,'course_crusher',true,100),
  ('ach_quiz_master','quiz_master','PERFORMANCE','quiz','سيّد الاختبارات','Quiz Master','انجح في ٢٠ اختبارًا','Pass 20 quizzes','quizzesPassed',20,500,250,'quiz_master',true,110),
  ('ach_perfect_5','perfect_5','PERFORMANCE','grade','خمس درجات كاملة','Flawless Five','احصل على ١٠٠٪ في ٥ اختبارات','Score 100% on 5 quizzes','perfectQuizzes',5,500,250,NULL,true,120),
  ('ach_streak_30','streak_30','CONSISTENCY','calendar_month','شهر كامل','Month Strong','حافظ على ٣٠ يومًا متتالية','Keep a 30-day streak','streakBest',30,600,300,'consistency_king',true,130),
  ('ach_streak_100','streak_100','CONSISTENCY','whatshot','مئة يوم','Unbreakable','حافظ على ١٠٠ يوم متتالية','Keep a 100-day streak','streakBest',100,1500,750,NULL,true,140),
  ('ach_top_10','top_10','COMPETITION','leaderboard','ضمن العشرة','Top 10','ادخل أفضل ١٠ في لوحة الصدارة','Reach the top 10','bestRank',10,300,150,NULL,true,150),
  ('ach_top_3','top_3','COMPETITION','emoji_events','منصة التتويج','Podium','ادخل أفضل ٣ في لوحة الصدارة','Reach the top 3','bestRank',3,600,300,NULL,true,160),
  ('ach_rank_1','rank_1','COMPETITION','trophy','الأول','Number One','كن الأول في لوحة الصدارة','Finish first on a leaderboard','bestRank',1,1000,500,'darsly_legend',true,170),
  ('ach_explorer_3','explorer_3','EXPLORATION','travel_explore','مستكشف','Explorer','ابدأ في ٣ كورسات مختلفة','Start 3 different courses','enrollments',3,200,100,NULL,true,180),
  ('ach_multi_subject','multi_subject','EXPLORATION','category','متعدد المواد','Well Rounded','تعلّم في مادتين مختلفتين','Learn across 2 subjects','distinctSubjects',2,250,125,NULL,true,190),
  ('ach_early_bird','early_bird','SPECIAL','wb_twilight','طائر الصباح','Early Bird','ذاكر ٥ مرات قبل الثامنة صباحًا','Study 5 times before 8am','earlyBirdSessions',5,200,100,NULL,true,200),
  ('ach_night_owl','night_owl','SPECIAL','bedtime','بومة الليل','Night Owl','ذاكر ٥ مرات بعد منتصف الليل','Study 5 times after midnight','nightOwlSessions',5,200,100,NULL,true,210),
  ('ach_weekend_warrior','weekend_warrior','SPECIAL','weekend','محارب الإجازة','Weekend Warrior','ذاكر في ٥ عطلات','Study on 5 weekends','weekendSessions',5,200,100,'speed_solver',true,220),
  ('ach_assignments_10','assignments_10','LEARNING','assignment_turned_in','ملتزم بالواجبات','On Top of It','سلّم ١٠ واجبات','Submit 10 assignments','assignmentsDone',10,300,150,NULL,true,230),
  ('ach_live_5','live_5','LEARNING','sensors','حاضر دائمًا','Always There','احضر ٥ جلسات مباشرة','Attend 5 live sessions','liveAttended',5,300,150,NULL,true,240)
ON CONFLICT ("key") DO NOTHING;

-- The starter reward store. Coins only — nothing here touches real money.
INSERT INTO "Reward" ("id","key","tenantId","category","kind","icon","titleAr","titleEn","descAr","descEn","costCoins","payload","stock","needsApproval","isActive","sortOrder") VALUES
  ('rwd_streak_freeze','streak_freeze',NULL,'PROGRESS','STREAK_FREEZE','ac_unit','تجميد السلسلة','Streak Freeze','يحمي سلسلتك ليوم واحد لو فاتك المذاكرة','Protects your streak for one missed day',150,'{"count":1}',NULL,false,true,10),
  ('rwd_xp_boost_2x','xp_boost_2x',NULL,'PROGRESS','XP_BOOST','bolt','مضاعفة النقاط ×٢','2× XP Boost','ضاعِف نقاط أول ٣ دروس تكمّلها','Doubles the XP of your next 3 lessons',300,'{"multiplier":2,"lessons":3}',NULL,false,true,20),
  ('rwd_xp_boost_15','xp_boost_15',NULL,'PROGRESS','XP_BOOST','trending_up','مضاعفة النقاط ×١.٥','1.5× XP Boost','زوّد نقاط أول ٥ دروس بنسبة ٥٠٪','+50% XP on your next 5 lessons',180,'{"multiplier":1.5,"lessons":5}',NULL,false,true,30),
  ('rwd_title_seeker','title_knowledge_seeker',NULL,'PROFILE','TITLE','travel_explore','لقب: باحث عن المعرفة','Title: Knowledge Seeker','أضف اللقب لملفك الشخصي','Unlock this title for your profile',400,'{"titleKey":"knowledge_seeker"}',NULL,false,true,40),
  ('rwd_title_speed','title_speed_solver',NULL,'PROFILE','TITLE','bolt','لقب: سريع الحل','Title: Speed Solver','أضف اللقب لملفك الشخصي','Unlock this title for your profile',400,'{"titleKey":"speed_solver"}',NULL,false,true,50)
ON CONFLICT ("key") DO NOTHING;
