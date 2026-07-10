import { IsUUID } from 'class-validator';

export class SessionLeaveDto {
  @IsUUID()
  sessionId!: string;
}
