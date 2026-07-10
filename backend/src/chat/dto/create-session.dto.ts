import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const PROVIDERS = ['ollama', 'claude', 'openai'] as const;

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsIn(PROVIDERS)
  defaultProvider!: (typeof PROVIDERS)[number];

  @IsString()
  @MaxLength(200)
  defaultModel!: string;
}
