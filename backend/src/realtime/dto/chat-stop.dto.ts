import { IsUUID } from 'class-validator';

export class ChatStopDto {
  @IsUUID()
  messageId!: string;
}
