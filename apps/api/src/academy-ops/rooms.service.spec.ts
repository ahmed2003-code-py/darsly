import { NotFoundException } from '@nestjs/common';
import { RoomsService } from './rooms.service';

function ctx(overrides: Partial<{ academyId: string; userId: string }> = {}) {
  return {
    academyId: 'a1',
    userId: 'owner1',
    role: 'OWNER',
    status: 'ACTIVE',
    isPlatformAdmin: false,
    can: () => true,
    ...overrides,
  } as any;
}

describe('RoomsService', () => {
  it('scopes list() to the caller academy', async () => {
    const prisma: any = { room: { findMany: jest.fn().mockResolvedValue([]) } };
    const audit: any = { log: jest.fn() };
    const svc = new RoomsService(prisma, audit);
    await svc.list(ctx());
    expect(prisma.room.findMany).toHaveBeenCalledWith({
      where: { academyId: 'a1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('404s updating a room from a different academy — never leaks it', async () => {
    const prisma: any = {
      room: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    };
    const audit: any = { log: jest.fn() };
    const svc = new RoomsService(prisma, audit);
    await expect(svc.update(ctx(), 'foreign-room', { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.room.update).not.toHaveBeenCalled();
  });

  it('audits room creation with academy context', async () => {
    const prisma: any = { room: { create: jest.fn().mockResolvedValue({ id: 'r1' }) } };
    const audit: any = { log: jest.fn() };
    const svc = new RoomsService(prisma, audit);
    await svc.create(ctx(), { name: 'Room A' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'room.create', academyId: 'a1' }),
    );
  });
});
