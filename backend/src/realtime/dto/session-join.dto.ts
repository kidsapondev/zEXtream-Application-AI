import { IsUUID } from 'class-validator';

export class SessionJoinDto {
  @IsUUID()
  sessionId!: string;
}
