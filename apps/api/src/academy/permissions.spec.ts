import { OWNER_ONLY, permissionsFor, ROLE_PERMISSIONS } from './permissions';

describe('permissionsFor — OWNER_ONLY ceiling', () => {
  it('an override can widen a TEACHER within their tier', () => {
    const set = permissionsFor('TEACHER', ['room.manage', 'analytics.read']);
    expect(set.has('analytics.read')).toBe(true);
  });

  it('an override can never hand OWNER_ONLY capabilities to a non-owner', () => {
    for (const role of ['TEACHER', 'ASSISTANT', 'STUDENT'] as const) {
      const set = permissionsFor(role, [...OWNER_ONLY]);
      for (const c of OWNER_ONLY) expect(set.has(c)).toBe(false);
    }
  });

  it('a STUDENT membership with a full override still gets nothing sensitive', () => {
    const set = permissionsFor('STUDENT', [
      'academy.manage',
      'member.manage',
      'wallet.withdraw',
      'course.write',
    ]);
    expect(set.has('academy.manage')).toBe(false);
    expect(set.has('member.manage')).toBe(false);
    expect(set.has('wallet.withdraw')).toBe(false);
    expect(set.has('course.write')).toBe(true); // within-tier grants are still data-driven
  });

  it('OWNER keeps everything, ceiling or not', () => {
    const set = permissionsFor('OWNER', []);
    for (const c of ROLE_PERMISSIONS.OWNER) expect(set.has(c)).toBe(true);
  });

  it('ignores garbage overrides', () => {
    expect(permissionsFor('ASSISTANT', ['nope', 42, null] as unknown).size).toBe(
      ROLE_PERMISSIONS.ASSISTANT.length,
    );
    expect(permissionsFor('ASSISTANT', 'not-an-array').size).toBe(
      ROLE_PERMISSIONS.ASSISTANT.length,
    );
  });
});
