-- A first, deliberately small set of Challenge achievements. More can be added
-- later as plain rows (no deploy needed) — see AchievementsService's own
-- comment: "adding an achievement is an INSERT". Not attempting to seed every
-- example the product brief named up front.
INSERT INTO "Achievement" ("id","key","category","icon","titleAr","titleEn","descAr","descEn","metric","threshold","xpReward","coinReward","titleKey","isActive","sortOrder") VALUES
  ('ach_challenge_first',     'challenge_first',     'LEARNING',    'bolt',          'أول تحدي',        'First Challenge',   'أكمِل أول تحدي',            'Complete your first Challenge', 'challengesCompleted', 1,  75,  40, NULL, true, 200),
  ('ach_challenge_ace',       'challenge_ace',       'PERFORMANCE', 'stars',         'بطل التحديات',    'Challenge Ace',     'احصل على درجة كاملة في تحدي', 'Score a perfect challenge',     'perfectChallenges',   1,  150, 75, NULL, true, 210),
  ('ach_challenge_ranked_10', 'challenge_ranked_10', 'COMPETITION', 'military_tech', 'محارب التحديات',  'Challenge Warrior',  'أنهِ ١٠ تحديات تنافسية',       'Finish 10 ranked Challenges',   'challengesWon',        10, 400, 200, NULL, true, 220);
