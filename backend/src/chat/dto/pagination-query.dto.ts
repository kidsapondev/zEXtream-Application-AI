// class-transformer's `@Type()` decorator calls `Reflect.defineMetadata` at class-definition
// time. In the running app this is polyfilled as a side effect of importing `@nestjs/core`
// (main.ts), but this file is also imported directly by standalone unit tests that never
// touch `@nestjs/core` — so polyfill it here explicitly rather than relying on import order.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Default page size when pagination is requested but `limit` is omitted. */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard ceiling on `limit` regardless of what the caller asks for. */
export const MAX_PAGE_SIZE = 200;

/**
 * Optional offset-based pagination for list endpoints (sessions, messages,
 * artifact revisions).
 *
 * Offset (not cursor-based) pagination was chosen deliberately: every list this
 * guards is scoped to a single user or session, not a global feed, so the
 * "skip cost grows with offset" downside of OFFSET/LIMIT never matters at this
 * app's scale, and it's far simpler to reason about (and to keep
 * backward-compatible) than a `createdAt`+`id` cursor.
 *
 * Both fields are optional and intentionally have no defaults *on the DTO
 * itself* — see `resolvePagination()`. Omitting both must reproduce each
 * endpoint's original (pre-pagination) query exactly, so "apply defaults when
 * pagination is requested at all" is handled one level up, not here.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Turns optional query params into a Prisma `{ take, skip }` pair, or
 * `undefined` when neither `limit` nor `offset` was supplied — callers must
 * spread that `undefined` case away (`...(pagination ? { ...pagination } : {})`)
 * rather than passing `{ take: undefined, skip: undefined }` through to
 * Prisma, so the omitted-params query is byte-for-byte what it was before
 * pagination existed.
 */
export function resolvePagination(
  query: PaginationQueryDto,
): { take: number; skip: number } | undefined {
  if (query.limit === undefined && query.offset === undefined) {
    return undefined;
  }
  return {
    take: query.limit ?? DEFAULT_PAGE_SIZE,
    skip: query.offset ?? 0,
  };
}
