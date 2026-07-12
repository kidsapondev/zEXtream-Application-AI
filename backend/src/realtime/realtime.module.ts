import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { WsRateLimiterService } from './ws-rate-limiter.service';
import { ChatModule } from '../chat/chat.module';
import { AiModule } from '../ai/ai.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ProviderSettingsModule } from '../provider-settings/provider-settings.module';
import { UsersModule } from '../users/users.module';

// ActiveStreamRegistry lives in ChatModule (not here) and is provided to
// ChatGateway transitively via ChatModule's exports. It cannot be provided
// by RealtimeModule directly: ChatSessionsService (in ChatModule) also needs
// it to cancel in-flight streams before a session is deleted, and ChatModule
// cannot import RealtimeModule back without creating a circular module
// dependency (RealtimeModule -> ChatModule -> RealtimeModule).
@Module({
  imports: [
    JwtModule.register({}),
    ChatModule,
    AiModule,
    ArtifactsModule,
    ProviderSettingsModule,
    UsersModule,
  ],
  providers: [ChatGateway, WsRateLimiterService],
})
export class RealtimeModule {}
