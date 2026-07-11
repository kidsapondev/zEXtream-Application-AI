import { IsString } from 'class-validator';
import { PaginationQueryDto } from '../../chat/dto/pagination-query.dto';

/**
 * Query params for `GET /chat/sessions/:sessionId/artifacts/revisions`.
 * `filename` is required (as it always was); `limit`/`offset` are the same
 * optional offset-based pagination as session/message lists — see
 * `PaginationQueryDto` for why offset over cursor.
 */
export class ListRevisionsQueryDto extends PaginationQueryDto {
  @IsString()
  filename!: string;
}
