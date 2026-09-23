import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * The two shapes a list may take, and nothing else.
 *
 * There were four, all invented separately: `{items,total,page,pageSize,pages}`
 * for courses, `{items,nextCursor}` for the audit log, `{total,page,pageSize,
 * groups}` for groups — the array under a different key for no reason — and a
 * bare array for the catalogue. Every client integration had to be written
 * against whichever one it happened to hit.
 *
 * Both shapes below are kept because both are needed, and they are not
 * interchangeable. Offset paging can say "page 7 of 43", which a screen with
 * numbered pages must show; it cannot stay correct while rows are inserted
 * underneath it. Cursor paging is stable against insertion, which is what a log
 * or a feed needs; it cannot say how many pages there are. Picking by what the
 * screen has to display is the rule.
 *
 * Nothing here removes a field. The existing responses gain the missing ones
 * and keep what they had — an old client reading `groups` or ignoring `pages`
 * is unaffected — because the alternative was a second version of five
 * endpoints for a change no reader asked for.
 */

/** Offset paging: for a list that shows its length. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** Cursor paging: for a log or a feed, stable while rows arrive. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The cap exists so a caller cannot ask for everything. 100 is the number the
 * audit log already used, kept rather than reinvented.
 */
export const MAX_PAGE_SIZE = 100;

/** Query parameters for an offset-paged endpoint. Both optional: omitting them
 *  must reproduce exactly what the endpoint returned before it was paged. */
export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/**
 * Turns the query into the two numbers Prisma needs.
 *
 * `fallbackSize` is the page size the endpoint used before it accepted a
 * `limit`, so that a caller who sends nothing gets byte-identical results. It
 * is not a default anyone should think about; it is the old hard-coded number.
 */
export function pageArgs(query: PageQuery, fallbackSize: number): { skip: number; take: number; page: number; pageSize: number } {
  const pageSize = Math.min(Math.max(query.limit ?? fallbackSize, 1), MAX_PAGE_SIZE);
  const page = Math.max(query.page ?? 1, 1);
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

/** Assembles the envelope, so `pages` is never computed three different ways. */
export function asPage<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
