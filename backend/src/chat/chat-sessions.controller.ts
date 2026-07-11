import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChatSessionsService } from './chat-sessions.service';
import { MessagesService } from './messages.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';

// Session creation is a DB write (and implicitly reserves a provider/model choice), not
// a cheap GET — tighter than the global default (100/min, see app.module.ts) so one
// user/IP can't spam empty sessions, while still being far above realistic UI usage
// (nobody clicks "new chat" 30 times in a minute).
const CREATE_SESSION_THROTTLE = { default: { limit: 30, ttl: 60_000 } };

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

  @Throttle(CREATE_SESSION_THROTTLE)
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessionsService.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.sessionsService.update(user.id, id, dto);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.sessionsService.remove(user.id, id);
    return { success: true };
  }

  @Get(':id/messages')
  async getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.sessionsService.getOwned(user.id, id);
    await this.messagesService.reconcileStuckMessages(id);
    return this.messagesService.listForSession(id);
  }
}
