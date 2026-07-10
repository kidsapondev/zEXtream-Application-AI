import { Controller, Get, Param, Query } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service';
import { ChatSessionsService } from '../chat/chat-sessions.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller('chat/sessions/:sessionId/artifacts')
export class ArtifactsController {
  constructor(
    private readonly artifactsService: ArtifactsService,
    private readonly sessionsService: ChatSessionsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Param('sessionId') sessionId: string) {
    await this.sessionsService.getOwned(user.id, sessionId);
    return this.artifactsService.listLatestForSession(sessionId);
  }

  @Get('revisions')
  async revisions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Query('filename') filename: string,
  ) {
    await this.sessionsService.getOwned(user.id, sessionId);
    return this.artifactsService.getRevisions(sessionId, filename);
  }
}
