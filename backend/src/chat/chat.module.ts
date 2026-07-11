import { Module } from '@nestjs/common';
import { ChatSessionsService } from './chat-sessions.service';
import { ChatSessionsController } from './chat-sessions.controller';
import { MessagesService } from './messages.service';
import { ActiveStreamRegistry } from './active-stream-registry.service';
import { ProviderSettingsModule } from '../provider-settings/provider-settings.module';

@Module({
  imports: [ProviderSettingsModule],
  controllers: [ChatSessionsController],
  providers: [ChatSessionsService, MessagesService, ActiveStreamRegistry],
  exports: [ChatSessionsService, MessagesService, ActiveStreamRegistry],
})
export class ChatModule {}
