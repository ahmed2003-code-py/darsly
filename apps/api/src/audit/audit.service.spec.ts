import { AuditService } from './audit.service';

/**
 * Phase 8: the Center Admin's own audit trail (`listForAcademy`) — the same
 * AuditLog table SUPER_ADMIN reads platform-wide, scoped hard to one academy
 * and cursor-paginated.
 */
function makePrisma(rows: any[]) {
  return {
    auditLog: {
      findMany: jest.fn(async (args: any) => {
        let result = rows.filter((r) => r.academyId === args.where.academyId);
        if (args.cursor) {
          const i = result.findIndex((r) => r.id === args.cursor.id);
          result = result.slice(i + (args.skip ?? 0));
        }
        return result.slice(0, args.take);
      }),
      create: jest.fn(),
    },
  } as any;
}

const row = (id: string, academyId: string) => ({
  id,
  academyId,
  action: 'x',
  createdAt: new Date(),
  actor: { fullName: 'A', role: 'TEACHER' },
});

describe('AuditService.listForAcademy', () => {
  it("scopes strictly to the given academyId — never mixes in another Center's rows", async () => {
    const prisma = makePrisma([row('l1', 'centerA'), row('l2', 'centerB'), row('l3', 'centerA')]);
    const svc = new AuditService(prisma);
    const out = await svc.listForAcademy('centerA');
    expect(out.items.every((r: any) => r.academyId === 'centerA')).toBe(true);
    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({ academyId: 'centerA' });
  });

  it('paginates: reports nextCursor and stops at the requested page size', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`l${i}`, 'centerA'));
    const prisma = makePrisma(rows);
    const svc = new AuditService(prisma);
    const out = await svc.listForAcademy('centerA', { take: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe(out.items[1].id);
  });

  it('reports no nextCursor once every row for the academy has been returned', async () => {
    const rows = [row('l1', 'centerA'), row('l2', 'centerA')];
    const prisma = makePrisma(rows);
    const svc = new AuditService(prisma);
    const out = await svc.listForAcademy('centerA', { take: 10 });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
  });

  it('clamps an out-of-range take into [1, 100]', async () => {
    const prisma = makePrisma([]);
    const svc = new AuditService(prisma);
    await svc.listForAcademy('centerA', { take: 5000 });
    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(101); // 100 + 1 lookahead
    await svc.listForAcademy('centerA', { take: -5 });
    expect(prisma.auditLog.findMany.mock.calls[1][0].take).toBe(2); // 1 + 1 lookahead
  });
});
