import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ChatSessionsService } from './chat-sessions.service';
import { MessagesService } from './messages.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller('chat/sessions')
export class ChatSessionsController {
  constructor(
    private readonly sessionsService: ChatSessionsService,
    private readonly messagesService: MessagesService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.sessionsService.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSessionDto) {
    return this.sessionsService.create(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return this.sessionsService.update(user.id, id, dto);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.sessionsService.remove(user.id, id);
    return { success: true };
  }

  @Get(':id/messages')
  async getMessages(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.sessionsService.getOwned(user.id, id);
    await this.messagesService.reconcileStuckMessages(id);
    return this.messagesService.listForSession(id);
  }
}
