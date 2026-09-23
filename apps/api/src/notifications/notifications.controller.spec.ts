import 'reflect-metadata';
import { JwtPayload } from '@darsly/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsController } from './notifications.controller';

/**
 * The defect: `take: 30` with no way to ask for the thirty-first.
 *
 * A reader with a busy term could not reach their own older notifications at
 * all. The rows were in the table and nothing addressed them — not a slow
 * endpoint, an unreachable one.
 *
 * The second thing asserted here matters as much: sending no parameters must
 * still return what it always returned, because the bell in the web app and
 * the Android app both call this with nothing.
 */
describe('notifications list', () => {
  const user = { sub: 'u1' } as JwtPayload;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let controller: NotificationsController;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([{ id: 'n1' }]);
    // 7 unread out of 95 total, so the two counts can never be confused.
    count = jest.fn().mockImplementation(({ where }) => (where.readAt === null ? 7 : 95));
    controller = new NotificationsController({
      notification: { findMany, count },
    } as unknown as PrismaService);
  });

  describe('a caller that sends nothing', () => {
    it('still reads the same first thirty', async () => {
      await controller.list(user, {});
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 30 }));
    });

    it('still gets items and unread under those names', async () => {
      const res = await controller.list(user, {});
      expect(res.items).toEqual([{ id: 'n1' }]);
      expect(res.unread).toBe(7);
    });
  });

  describe('a caller that asks for more', () => {
    /** The regression: before this, page 2 did not exist. */
    it('reaches past the first thirty', async () => {
      await controller.list(user, { page: 2 });
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 30, take: 30 }));
    });

    it('is told how far the list goes', async () => {
      const res = await controller.list(user, { page: 2 });
      expect(res).toMatchObject({ total: 95, page: 2, pageSize: 30, pages: 4 });
    });

    it('cannot ask for the whole table', async () => {
      await controller.list(user, { limit: 10_000 });
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });
  });

  describe('the number on the bell', () => {
    /**
     * `unread` is what the bell shows. It is counted over every notification,
     * so it must not change because the reader turned to page two or filtered
     * the list to unread only.
     */
    it('counts every unread notification, not the ones on this page', async () => {
      const res = await controller.list(user, { page: 3, unreadOnly: 'true' });
      expect(res.unread).toBe(7);
      expect(count).toHaveBeenCalledWith({ where: { userId: 'u1', readAt: null } });
    });
  });
});
