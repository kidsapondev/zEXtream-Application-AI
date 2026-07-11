import { Controller, Get, Param, Query } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service';
import { ListRevisionsQueryDto } from './dto/list-revisions-query.dto';
import { resolvePagination } from '../chat/dto/pagination-query.dto';
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
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ) {
    await this.sessionsService.getOwned(user.id, sessionId);
    return this.artifactsService.listLatestForSession(sessionId);
  }

  // `limit`/`offset` are optional; omitting both returns exactly what this
  // endpoint returned before pagination existed (full revision history, oldest first).
  @Get('revisions')
  async revisions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
    @Query() query: ListRevisionsQueryDto,
  ) {
    await this.sessionsService.getOwned(user.id, sessionId);
    return this.artifactsService.getRevisions(
      sessionId,
      query.filename,
      resolvePagination(query),
    );
  }
}
