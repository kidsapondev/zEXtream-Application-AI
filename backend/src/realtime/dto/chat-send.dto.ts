import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { AiProviderKey } from '../../ai/ai-provider.interface';
import { ENABLED_PROVIDERS } from '../../chat/dto/create-session.dto';
import { MAX_CHAT_MESSAGE_BYTES } from '../../chat/messages.service';
import { MaxUtf8Bytes } from './max-utf8-bytes.validator';

export class ChatSendDto {
  @IsUUID()
  sessionId!: string;

  @IsString()
  @MaxUtf8Bytes(MAX_CHAT_MESSAGE_BYTES)
  content!: string;

  @IsOptional()
  @IsIn(ENABLED_PROVIDERS)
  provider?: AiProviderKey;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;
}
