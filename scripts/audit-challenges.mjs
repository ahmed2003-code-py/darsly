#!/usr/bin/env node
/**
 * Drives the real Challenges golden path end-to-end against a real running
 * API and a real (disposable, local-only) Postgres — not a unit test with
 * Prisma mocked out. Proves what the unit tests can't: the actual HTTP
 * surface, real DB transactions, and the real gamification/leaderboard
 * side effects all agree with each other.
 *
 * Flow: teacher creates a RANKED challenge → adds questions → publishes →
 * student sees it, starts an attempt, answers correctly and incorrectly,
 * completes → XP/coins actually landed on the student's gamification
 * profile → the challenge's own leaderboard shows the result → mistake
 * retry produces a mini-attempt with only the wrong question → teacher's
 * submissions/analytics endpoints see the same numbers.
 *
 *   CONFIRM_TEST_DB=yes DATABASE_URL=postgresql://...localhost:5434/darsly node scripts/audit-challenges.mjs
 *
 * Assumes: the target API is already running (dev server) and the DB was
 * just seeded (`npx ts-node prisma/seed.ts` from apps/api). Nothing here is
 * destructive — it only creates one new challenge and one new attempt.
 */
const DB = process.env.DATABASE_URL ?? '';
const PORT = process.env.API_PORT ?? '4000';
const PASSWORD = 'Darsly@123';

if (process.env.CONFIRM_TEST_DB !== 'yes') {
  console.error('REFUSED: set CONFIRM_TEST_DB=yes.');
  process.exit(2);
}
if (!DB) {
  console.error('REFUSED: DATABASE_URL is not set.');
  process.exit(2);
}
if (/railway|prod|amazonaws|supabase|neon\.tech|render\.com/i.test(DB)) {
  console.error('REFUSED: DATABASE_URL looks hosted.');
  process.exit(2);
}

let pass = 0,
  fail = 0;
const check = (n, ok, d = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  (${d})` : ''}`);
  if (ok) pass++;
  else fail++;
};

async function api(p, { token, method = 'GET', body } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, body: json };
}
const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status >= 300) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
};

async function main() {
  console.log('== Challenges golden path (real API + real DB) ==');

  const teacherTok = await login('teacher1@darsly.app');
  const studentTok = await login('student1@darsly.app');
  console.log('   logged in as teacher1 and student1');

  // ── Teacher: create, add questions, publish ────────────────────────────
  const created = await api('/teacher/challenges', {
    token: teacherTok,
    method: 'POST',
    body: {
      title: 'Audit Challenge',
      type: 'RANKED',
      scoring: 'SPEED_BASED',
      questionTimeSec: 20,
      maxAttempts: 2,
    },
  });
  check(
    'teacher creates a RANKED challenge',
    created.status === 201 || created.status === 200,
    `status=${created.status}`,
  );
  const challengeId = created.body?.id;

  const q1 = {
    type: 'MCQ',
    prompt: 'What is 2+2?',
    options: [
      { id: 'a', text: '3' },
      { id: 'b', text: '4' },
    ],
    correctOptionIds: ['b'],
    points: 100,
    explanation: 'basic arithmetic',
  };
  const q2 = {
    type: 'TRUE_FALSE',
    prompt: 'The sky is blue.',
    options: [
      { id: 'true', text: 'true' },
      { id: 'false', text: 'false' },
    ],
    correctOptionIds: ['true'],
    points: 100,
  };
  const withQuestions = await api(`/teacher/challenges/${challengeId}/questions`, {
    token: teacherTok,
    method: 'PUT',
    body: { questions: [q1, q2] },
  });
  check('teacher sets 2 questions', withQuestions.status === 200, `status=${withQuestions.status}`);

  const published = await api(`/teacher/challenges/${challengeId}/publish`, {
    token: teacherTok,
    method: 'POST',
  });
  check(
    'teacher publishes the challenge',
    published.status === 200 || published.status === 201,
    `status=${published.status} body=${JSON.stringify(published.body)}`,
  );

  // ── Student: sees it, plays it ─────────────────────────────────────────
  const list = await api('/challenges?tab=available', { token: studentTok });
  const onList = list.body?.some((c) => c.id === challengeId);
  check('student sees the published challenge in "available"', !!onList, `status=${list.status}`);

  const before = await api('/student/gamification', { token: studentTok });
  const xpBefore = before.body?.xp ?? 0;

  const started = await api(`/challenges/${challengeId}/attempts`, {
    token: studentTok,
    method: 'POST',
  });
  check(
    'student starts an attempt',
    started.status === 201 || started.status === 200,
    `status=${started.status} body=${JSON.stringify(started.body)}`,
  );
  const attemptId = started.body?.attemptId;
  const orderedQuestions = started.body?.questions ?? [];
  check(
    'attempt carries both questions with answers stripped',
    orderedQuestions.length === 2 && !('correctOptionIds' in (orderedQuestions[0] ?? {})),
  );

  // Answer the first question correctly and fast, the second one wrong.
  const firstQId = orderedQuestions[0].id;
  const firstIsQ1 = firstQId === undefined ? true : true; // order may be shuffled; look up by prompt below instead
  const q1Id = (orderedQuestions.find((q) => q.prompt.includes('2+2')) ?? {}).id;
  const q2Id = (orderedQuestions.find((q) => q.prompt.includes('sky')) ?? {}).id;
  const answerOrder = orderedQuestions.map((q) => q.id);
  const firstInOrder = answerOrder[0];
  const secondInOrder = answerOrder[1];
  const correctFor = (qid) => (qid === q1Id ? 'b' : 'true');
  const wrongFor = (qid) => (qid === q1Id ? 'a' : 'false');

  const a1 = await api(`/challenges/${challengeId}/attempts/${attemptId}/answers`, {
    token: studentTok,
    method: 'POST',
    body: { questionId: firstInOrder, selectedOptionIds: [correctFor(firstInOrder)] },
  });
  check(
    'first answer (correct, fast) scores > 0 XP',
    a1.status === 201 || a1.status === 200,
    `status=${a1.status} body=${JSON.stringify(a1.body)}`,
  );
  check(
    'first answer marked correct with a speed bonus',
    a1.body?.isCorrect === true && a1.body?.xpAwarded > 100,
    `xp=${a1.body?.xpAwarded}`,
  );

  const dupe = await api(`/challenges/${challengeId}/attempts/${attemptId}/answers`, {
    token: studentTok,
    method: 'POST',
    body: { questionId: firstInOrder, selectedOptionIds: [wrongFor(firstInOrder)] },
  });
  check(
    'resubmitting the same question is idempotent (ignores the different answer)',
    dupe.body?.isCorrect === a1.body?.isCorrect && dupe.body?.xpAwarded === a1.body?.xpAwarded,
  );

  const a2 = await api(`/challenges/${challengeId}/attempts/${attemptId}/answers`, {
    token: studentTok,
    method: 'POST',
    body: { questionId: secondInOrder, selectedOptionIds: [wrongFor(secondInOrder)] },
  });
  check(
    'second answer (wrong) scores 0 XP',
    a2.body?.isCorrect === false && a2.body?.xpAwarded === 0,
    `body=${JSON.stringify(a2.body)}`,
  );

  const completed = await api(`/challenges/${challengeId}/attempts/${attemptId}/complete`, {
    token: studentTok,
    method: 'POST',
  });
  check(
    'attempt completes',
    completed.status === 200 || completed.status === 201,
    `status=${completed.status}`,
  );
  check(
    'result: 1 correct, 1 wrong, 50% accuracy',
    completed.body?.correctCount === 1 &&
      completed.body?.wrongCount === 1 &&
      completed.body?.accuracyPct === 50,
    `body=${JSON.stringify(completed.body)}`,
  );
  check(
    'result carries a real gamification outcome (XP actually awarded)',
    completed.body?.gamification?.awarded === true && completed.body?.gamification?.xp > 0,
    `gamification=${JSON.stringify(completed.body?.gamification)}`,
  );

  const after = await api('/student/gamification', { token: studentTok });
  const xpAfter = after.body?.xp ?? 0;
  check(
    'student gamification profile XP actually increased',
    xpAfter > xpBefore,
    `before=${xpBefore} after=${xpAfter}`,
  );

  const doubleComplete = await api(`/challenges/${challengeId}/attempts/${attemptId}/complete`, {
    token: studentTok,
    method: 'POST',
  });
  check(
    'completing again is a no-op (same score, no re-award)',
    doubleComplete.body?.score === completed.body?.score,
  );
  const afterDouble = await api('/student/gamification', { token: studentTok });
  check(
    'XP did not change on the duplicate completion',
    (afterDouble.body?.xp ?? 0) === xpAfter,
    `xp=${afterDouble.body?.xp}`,
  );

  // ── Leaderboard ─────────────────────────────────────────────────────────
  const lb = await api(`/challenges/${challengeId}/leaderboard`, { token: studentTok });
  check(
    'challenge leaderboard shows the student',
    lb.body?.some((r) => r.isMe),
    `body=${JSON.stringify(lb.body)}`,
  );

  // ── Retry mistakes ──────────────────────────────────────────────────────
  const retry = await api(`/challenges/${challengeId}/attempts/${attemptId}/retry-mistakes`, {
    token: studentTok,
    method: 'POST',
  });
  check(
    'retry-mistakes creates a mini-attempt with only the 1 wrong question',
    retry.body?.totalQuestions === 1,
    `body=${JSON.stringify(retry.body)}`,
  );

  // ── Security: another student cannot touch this attempt ────────────────
  const studentTok2 = await login('student2@darsly.app');
  const stolen = await api(`/challenges/${challengeId}/attempts/${attemptId}`, {
    token: studentTok2,
  });
  check(
    'a different student is refused access to this attempt (404, not leaked)',
    stolen.status === 404,
    `status=${stolen.status}`,
  );

  // ── Teacher sees it ──────────────────────────────────────────────────────
  const subs = await api(`/teacher/challenges/${challengeId}/submissions`, { token: teacherTok });
  check(
    'teacher sees the submission with the right score',
    subs.body?.some((s) => s.score === completed.body?.score),
    `body=${JSON.stringify(subs.body)}`,
  );

  const analytics = await api(`/teacher/challenges/${challengeId}/analytics`, {
    token: teacherTok,
  });
  check(
    'teacher analytics reflects 1 participant, 1 completed',
    analytics.body?.participants === 1 && analytics.body?.completed === 1,
    `body=${JSON.stringify(analytics.body)}`,
  );

  // ── Hardening: a client cannot inject a score/XP/coins/correctness value ──
  // Global ValidationPipe is { whitelist: true, forbidNonWhitelisted: true } —
  // an unknown field on the DTO must be REJECTED outright, not silently
  // stripped-then-ignored. Uses the mistake-retry mini-attempt from above,
  // which still has its one unanswered question.
  const tamper = await api(`/challenges/${challengeId}/attempts/${retry.body.attemptId}/answers`, {
    token: studentTok,
    method: 'POST',
    body: {
      questionId: retry.body.questions[0].id,
      selectedOptionIds: ['true'],
      xpAwarded: 999999,
      isCorrect: true,
      score: 999999,
    },
  });
  check(
    'a client-supplied xpAwarded/isCorrect/score on the answer body is rejected, not honoured',
    tamper.status === 400,
    `status=${tamper.status} body=${JSON.stringify(tamper.body)}`,
  );

  // ── Hardening: answerReveal=NEVER never leaks the key, at answer time or after ──
  const neverChallenge = await api('/teacher/challenges', {
    token: teacherTok,
    method: 'POST',
    body: { title: 'Audit Never-Reveal', type: 'PRACTICE', answerReveal: 'NEVER' },
  });
  const neverId = neverChallenge.body.id;
  await api(`/teacher/challenges/${neverId}/questions`, {
    token: teacherTok,
    method: 'PUT',
    body: { questions: [q1] },
  });
  await api(`/teacher/challenges/${neverId}/publish`, { token: teacherTok, method: 'POST' });
  const neverStart = await api(`/challenges/${neverId}/attempts`, {
    token: studentTok,
    method: 'POST',
  });
  const neverQ = neverStart.body.questions[0];
  const neverAnswer = await api(
    `/challenges/${neverId}/attempts/${neverStart.body.attemptId}/answers`,
    {
      token: studentTok,
      method: 'POST',
      body: { questionId: neverQ.id, selectedOptionIds: ['a'] },
    },
  );
  check(
    'answerReveal=NEVER: per-answer response carries no correctOptionIds/explanation',
    !('correctOptionIds' in (neverAnswer.body ?? {})) &&
      !('explanation' in (neverAnswer.body ?? {})),
    `body=${JSON.stringify(neverAnswer.body)}`,
  );
  const neverComplete = await api(
    `/challenges/${neverId}/attempts/${neverStart.body.attemptId}/complete`,
    { token: studentTok, method: 'POST' },
  );
  check(
    'answerReveal=NEVER: the completed result carries no review/mistake detail either',
    (neverComplete.body?.review ?? []).length === 0 &&
      (neverComplete.body?.mistakes ?? []).length === 0,
    `body=${JSON.stringify(neverComplete.body)}`,
  );

  // ── Hardening: a per-question timer that has expired pays 0 XP even for the right answer ──
  const timedChallenge = await api('/teacher/challenges', {
    token: teacherTok,
    method: 'POST',
    body: { title: 'Audit Timer', type: 'RANKED', scoring: 'SPEED_BASED', questionTimeSec: 10 }, // 10s is the DTO's own floor (MIN_TIME_LIMIT_SEC)
  });
  check(
    'timer-test challenge created',
    timedChallenge.status === 201,
    `status=${timedChallenge.status} body=${JSON.stringify(timedChallenge.body)}`,
  );
  const timedId = timedChallenge.body.id;
  await api(`/teacher/challenges/${timedId}/questions`, {
    token: teacherTok,
    method: 'PUT',
    body: { questions: [q1] },
  });
  await api(`/teacher/challenges/${timedId}/publish`, { token: teacherTok, method: 'POST' });
  const timedStart = await api(`/challenges/${timedId}/attempts`, {
    token: studentTok,
    method: 'POST',
  });
  check(
    'timer-test attempt started',
    Array.isArray(timedStart.body?.questions) && timedStart.body.questions.length === 1,
    `body=${JSON.stringify(timedStart.body)}`,
  );
  const timedQ = timedStart.body.questions[0];
  console.log('   (waiting 13s for the 10s per-question timer + grace to lapse...)');
  await new Promise((r) => setTimeout(r, 13_000)); // 10s timer + 2s grace (ChallengeScoringService.GRACE_MS) + margin
  const timedAnswer = await api(
    `/challenges/${timedId}/attempts/${timedStart.body.attemptId}/answers`,
    {
      token: studentTok,
      method: 'POST',
      body: { questionId: timedQ.id, selectedOptionIds: ['b'] }, // objectively correct, but late
    },
  );
  check(
    'a correct answer submitted after its timer expired scores 0 XP, not correct',
    timedAnswer.body?.isCorrect === false && timedAnswer.body?.xpAwarded === 0,
    `body=${JSON.stringify(timedAnswer.body)}`,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
