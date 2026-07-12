import 'reflect-metadata';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../chat/dto/pagination-query.dto';

export class AdminUsersQueryDto extends PaginationQueryDto {
  /** Case-insensitive substring match against email or display name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;
}
