import { PrismaService } from '../prisma/prisma.service';
import { SubjectExclusivityService } from './subject-exclusivity.service';

/**
 * Who a student is allowed to be shown.
 *
 * The failure this guards against is not a crash — it is the platform quietly
 * advertising rival tutors to an audience a teacher brought in themselves. The
 * cases below are mostly about where the line falls: which enrolments count as a
 * commitment, whose catalogue disappears, and who is exempt entirely.
 */

type Teacher = { id: string; subjectIds: string[] };
type Enrolment = { tenantId: string; status: string };

function build(world: {
  student?: { id: string } | null;
  enrolments?: Enrolment[];
  teachers?: Teacher[];
}) {
  const teachers = world.teachers ?? [];
  const enrolments = world.enrolments ?? [];

  const prisma = {
    studentProfile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(world.student === undefined ? { id: 'st_1' } : world.student),
    },
    enrollment: {
      findMany: jest.fn(async ({ where }: any) => {
        const allowed: string[] = where.status.in;
        const rows = enrolments.filter((e) => allowed.includes(e.status));
        // `distinct` in the real query; mirrored so the test data can be written
        // the way it actually occurs, with repeats.
        return [...new Map(rows.map((e) => [e.tenantId, e])).values()];
      }),
    },
    teacherSubject: {
      findMany: jest.fn(async ({ where }: any) => {
        const rows = teachers.filter((t) => where.tenantId.in.includes(t.id));
        const pairs = rows.flatMap((t) => t.subjectIds.map((subjectId) => ({ subjectId })));
        // `distinct` in the real query, mirrored here so a teacher who takes
        // both school systems does not report the same subject twice.
        return [...new Set(pairs.map((p) => p.subjectId))].map((subjectId) => ({ subjectId }));
      }),
    },
    teacherProfile: {
      findMany: jest.fn(async ({ where }: any) => {
        let rows = teachers;
        if (where.id?.notIn) rows = rows.filter((t) => !where.id.notIn.includes(t.id));
        const wanted: string[] | undefined = where.subjects?.some?.subjectId?.in;
        if (wanted) rows = rows.filter((t) => t.subjectIds.some((s) => wanted.includes(s)));
        return rows.map((t) => ({ id: t.id }));
      }),
    },
  } as unknown as PrismaService;

  return { service: new SubjectExclusivityService(prisma), prisma };
}

const WORLD = {
  teachers: [
    { id: 'mine_ar', subjectIds: ['arabic'] },
    { id: 'rival_ar', subjectIds: ['arabic'] },
    { id: 'another_ar', subjectIds: ['arabic'] },
    { id: 'phys', subjectIds: ['physics'] },
    { id: 'chem', subjectIds: ['chemistry'] },
  ],
};

describe('a student studying a subject stops seeing its other teachers', () => {
  it('hides every other teacher of that subject', async () => {
    const { service } = build({
      ...WORLD,
      enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }],
    });
    const hidden = await service.hiddenTeacherIds('u1');
    expect(hidden.sort()).toEqual(['another_ar', 'rival_ar']);
  });

  it('never hides the teacher the student actually studies with', async () => {
    const { service } = build({
      ...WORLD,
      enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }],
    });
    expect(await service.hiddenTeacherIds('u1')).not.toContain('mine_ar');
  });

  it('leaves every other subject open', async () => {
    // The rule protects a teacher's subject, not their student: physics and
    // chemistry stay browsable from anyone.
    const { service } = build({
      ...WORLD,
      enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }],
    });
    const hidden = await service.hiddenTeacherIds('u1');
    expect(hidden).not.toContain('phys');
    expect(hidden).not.toContain('chem');
  });

  it('hides across every subject the student has committed to', async () => {
    const { service } = build({
      ...WORLD,
      enrolments: [
        { tenantId: 'mine_ar', status: 'ACTIVE' },
        { tenantId: 'phys', status: 'ACTIVE' },
      ],
    });
    const hidden = await service.hiddenTeacherIds('u1');
    expect(hidden.sort()).toEqual(['another_ar', 'rival_ar']);
    // Physics has no second teacher to hide, and the student's own two stay.
    expect(hidden).not.toContain('phys');
  });

  it("treats two teachers of one subject as both the student's own", async () => {
    // A student who signed up with two Arabic teachers before the rule existed
    // keeps both; only third parties go.
    const { service } = build({
      ...WORLD,
      enrolments: [
        { tenantId: 'mine_ar', status: 'ACTIVE' },
        { tenantId: 'rival_ar', status: 'ACTIVE' },
      ],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual(['another_ar']);
  });
});

describe('what counts as studying with someone', () => {
  it('counts an enrolment awaiting the teacher approval', async () => {
    // The student has asked, and often paid. The choice is made.
    const { service } = build({
      ...WORLD,
      enrolments: [{ tenantId: 'mine_ar', status: 'PENDING_PAYMENT' }],
    });
    expect(await service.hiddenTeacherIds('u1')).toContain('rival_ar');
  });

  it('does not count an expired or revoked enrolment', async () => {
    // The relationship is over. A student who has finished with a teacher must
    // be able to find another one, or the rule becomes a life sentence.
    const { service } = build({
      ...WORLD,
      enrolments: [
        { tenantId: 'mine_ar', status: 'EXPIRED' },
        { tenantId: 'phys', status: 'REVOKED' },
      ],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });

  it('does not count a rejected request', async () => {
    const { service } = build({
      ...WORLD,
      enrolments: [{ tenantId: 'mine_ar', status: 'REJECTED' }],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });
});

describe('who the rule does not apply to', () => {
  it('hides nothing from an anonymous visitor', async () => {
    const { service, prisma } = build(WORLD);
    expect(await service.hiddenTeacherIds(undefined)).toEqual([]);
    // And costs nothing: the common case must not query at all.
    expect(prisma.studentProfile.findUnique).not.toHaveBeenCalled();
  });

  it('hides nothing from a teacher or an admin', async () => {
    // They have no student profile, so there is no enrolment to reason from and
    // no reason to narrow the platform for them.
    const { service } = build({ ...WORLD, student: null });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });

  it('hides nothing from a student who has not enrolled anywhere', async () => {
    const { service } = build({ ...WORLD, enrolments: [] });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });

  it("hides nothing when the student's teacher has no subject set", async () => {
    // Nothing to compare against — better to show everyone than to guess.
    const { service } = build({
      teachers: [
        { id: 'mine', subjectIds: [] },
        { id: 'other', subjectIds: ['arabic'] },
      ],
      enrolments: [{ tenantId: 'mine', status: 'ACTIVE' }],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });

  /**
   * A teacher who takes both school systems is one person, and a rival on the
   * strength of any subject they share — not only the one they are best known
   * for. Matching on a single subject each would have let the maths teacher who
   * also teaches "Math" keep appearing beside the one this student pays.
   */
  it('hides a rival who shares only one of several subjects', async () => {
    const { service } = build({
      teachers: [
        { id: 'mine', subjectIds: ['math-gen'] },
        { id: 'rival_both', subjectIds: ['math-gen', 'math-lang'] },
        { id: 'lang_only', subjectIds: ['math-lang'] },
      ],
      enrolments: [{ tenantId: 'mine', status: 'ACTIVE' }],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual(['rival_both']);
  });
});
