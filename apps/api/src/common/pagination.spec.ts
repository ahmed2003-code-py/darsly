import 'reflect-metadata';
import { MAX_PAGE_SIZE, asPage, pageArgs } from './pagination';

/**
 * The promise this module makes is not that paging works — it is that adding
 * paging to five endpoints changed nothing for a caller who does not use it.
 * That promise is what these assert.
 */
describe('pagination', () => {
  describe('an endpoint that gains paging must behave identically without it', () => {
    it('reproduces the old hard-coded window when nothing is asked for', () => {
      expect(pageArgs({}, 30)).toEqual({ skip: 0, take: 30, page: 1, pageSize: 30 });
    });

    it('uses each endpoint’s own former limit, not a shared default', () => {
      expect(pageArgs({}, 12).take).toBe(12);
      expect(pageArgs({}, 100).take).toBe(100);
    });
  });

  describe('what a caller may ask for', () => {
    it('skips whole pages, not rows', () => {
      expect(pageArgs({ page: 3, limit: 20 }, 30)).toMatchObject({ skip: 40, take: 20 });
    });

    it('refuses to let a caller ask for everything', () => {
      expect(pageArgs({ limit: 5_000 }, 30).take).toBe(MAX_PAGE_SIZE);
    });

    it('treats a nonsensical page as the first one', () => {
      expect(pageArgs({ page: 0 }, 30).page).toBe(1);
      expect(pageArgs({ page: -4 }, 30).skip).toBe(0);
    });
  });

  describe('the envelope', () => {
    it('reports the number of pages, not the number of rows', () => {
      expect(asPage([1, 2], 43, 1, 10).pages).toBe(5);
    });

    /** An empty list is page 1 of 1, never page 1 of 0. */
    it('never reports zero pages', () => {
      expect(asPage([], 0, 1, 30).pages).toBe(1);
    });

    it('keeps total as the count of everything, not of the page', () => {
      expect(asPage([1, 2, 3], 97, 2, 3)).toEqual({
        items: [1, 2, 3],
        total: 97,
        page: 2,
        pageSize: 3,
        pages: 33,
      });
    });
  });
});
