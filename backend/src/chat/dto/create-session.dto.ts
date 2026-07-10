import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const ENABLED_PROVIDERS = ['ollama'] as const;

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsIn(ENABLED_PROVIDERS)
  defaultProvider!: (typeof ENABLED_PROVIDERS)[number];

  @IsString()
  @MaxLength(200)
  defaultModel!: string;
}
