import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// The DTO-level allowlist reflects what the runtime supports (all three
// providers have an AiProvider implementation registered in AiProviderFactory).
// Whether a *given user* may actually start a session with claude/openai is a
// separate, per-user check (they must have configured an API key) enforced in
// ChatSessionsService.create() and ChatGateway.onChatSend, not here.
export const ENABLED_PROVIDERS = ['ollama', 'claude', 'openai'] as const;

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
