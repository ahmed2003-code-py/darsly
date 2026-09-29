-- Live Bonus: points a teacher grants in class, through the canonical gamification
-- economy (XpRule / GamificationEvent). Additive: three nullable limit columns on
-- XpRule, and the LIVE_BONUS rule (1 point = 10 XP + 5 coins; at most 10 per award,
-- 20 per student per class, 300 per class) — every value admin-tunable.

-- AlterTable
ALTER TABLE "XpRule" ADD COLUMN     "maxPerAward" INTEGER,
ADD COLUMN     "maxPerEntity" INTEGER,
ADD COLUMN     "maxPerStudentEntity" INTEGER;


INSERT INTO "XpRule" ("id", "event", "xp", "coins", "dailyCap", "perEntityLimit", "maxPerAward", "maxPerStudentEntity", "maxPerEntity", "isActive", "updatedAt")
VALUES ('xpr_live_bonus', 'LIVE_BONUS', 10, 5, 0, 0, 10, 20, 300, true, CURRENT_TIMESTAMP)
ON CONFLICT ("event") DO NOTHING;
