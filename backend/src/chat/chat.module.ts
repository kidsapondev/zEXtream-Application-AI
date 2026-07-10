import { Module } from '@nestjs/common';
import { ChatSessionsService } from './chat-sessions.service';
import { ChatSessionsController } from './chat-sessions.controller';
import { MessagesService } from './messages.service';

@Module({
  controllers: [ChatSessionsController],
  providers: [ChatSessionsService, MessagesService],
  exports: [ChatSessionsService, MessagesService],
})
export class ChatModule {}
