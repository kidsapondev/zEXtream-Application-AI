import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ENABLED_PROVIDERS } from './create-session.dto';

export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;

  @IsOptional()
  @IsIn(ENABLED_PROVIDERS)
  defaultProvider?: (typeof ENABLED_PROVIDERS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  defaultModel?: string;
}
