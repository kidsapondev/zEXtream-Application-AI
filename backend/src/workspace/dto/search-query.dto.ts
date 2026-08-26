import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Query params for `GET /workspace/search`. */
export class SearchQueryDto {
  /** A literal substring, not a regular expression — see the host-bridge's search. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  path?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  maxResults?: number;
}
