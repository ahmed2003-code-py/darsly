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

type Teacher = { id: string; subjectId: string | null };
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
      findUnique: jest.fn().mockResolvedValue(world.student === undefined ? { id: 'st_1' } : world.student),
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
    teacherProfile: {
      findMany: jest.fn(async ({ where, select }: any) => {
        let rows = teachers;
        if (where.id?.in) rows = rows.filter((t) => where.id.in.includes(t.id));
        if (where.id?.notIn) rows = rows.filter((t) => !where.id.notIn.includes(t.id));
        if (where.subjectId?.in) rows = rows.filter((t) => t.subjectId && where.subjectId.in.includes(t.subjectId));
        return rows.map((t) => (select?.id ? { id: t.id } : { subjectId: t.subjectId }));
      }),
    },
  } as unknown as PrismaService;

  return { service: new SubjectExclusivityService(prisma), prisma };
}

const WORLD = {
  teachers: [
    { id: 'mine_ar', subjectId: 'arabic' },
    { id: 'rival_ar', subjectId: 'arabic' },
    { id: 'another_ar', subjectId: 'arabic' },
    { id: 'phys', subjectId: 'physics' },
    { id: 'chem', subjectId: 'chemistry' },
  ],
};

describe('a student studying a subject stops seeing its other teachers', () => {
  it('hides every other teacher of that subject', async () => {
    const { service } = build({ ...WORLD, enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }] });
    const hidden = await service.hiddenTeacherIds('u1');
    expect(hidden.sort()).toEqual(['another_ar', 'rival_ar']);
  });

  it('never hides the teacher the student actually studies with', async () => {
    const { service } = build({ ...WORLD, enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }] });
    expect(await service.hiddenTeacherIds('u1')).not.toContain('mine_ar');
  });

  it('leaves every other subject open', async () => {
    // The rule protects a teacher's subject, not their student: physics and
    // chemistry stay browsable from anyone.
    const { service } = build({ ...WORLD, enrolments: [{ tenantId: 'mine_ar', status: 'ACTIVE' }] });
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

  it('treats two teachers of one subject as both the student\'s own', async () => {
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
    const { service } = build({ ...WORLD, enrolments: [{ tenantId: 'mine_ar', status: 'PENDING_APPROVAL' }] });
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
    const { service } = build({ ...WORLD, enrolments: [{ tenantId: 'mine_ar', status: 'REJECTED' }] });
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

  it('hides nothing when the student\'s teacher has no subject set', async () => {
    // Nothing to compare against — better to show everyone than to guess.
    const { service } = build({
      teachers: [{ id: 'mine', subjectId: null }, { id: 'other', subjectId: 'arabic' }],
      enrolments: [{ tenantId: 'mine', status: 'ACTIVE' }],
    });
    expect(await service.hiddenTeacherIds('u1')).toEqual([]);
  });
});
