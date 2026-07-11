import {
  DEFAULT_PAGE_SIZE,
  PaginationQueryDto,
  resolvePagination,
} from './pagination-query.dto';

function query(partial: Partial<PaginationQueryDto>): PaginationQueryDto {
  const dto = new PaginationQueryDto();
  return Object.assign(dto, partial);
}

describe('resolvePagination', () => {
  it('returns undefined when both limit and offset are omitted', () => {
    expect(resolvePagination(query({}))).toBeUndefined();
  });

  it('defaults offset to 0 when only limit is given', () => {
    expect(resolvePagination(query({ limit: 10 }))).toEqual({
      take: 10,
      skip: 0,
    });
  });

  it('defaults limit to the standard page size when only offset is given', () => {
    expect(resolvePagination(query({ offset: 20 }))).toEqual({
      take: DEFAULT_PAGE_SIZE,
      skip: 20,
    });
  });

  it('uses both values verbatim when both are given', () => {
    expect(resolvePagination(query({ limit: 5, offset: 15 }))).toEqual({
      take: 5,
      skip: 15,
    });
  });
});
