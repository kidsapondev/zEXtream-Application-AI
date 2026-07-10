import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';
import { ActiveStreamRegistry } from './active-stream-registry.service';
import { ChatModule } from '../chat/chat.module';
import { AiModule } from '../ai/ai.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';

@Module({
  imports: [JwtModule.register({}), ChatModule, AiModule, ArtifactsModule],
  providers: [ChatGateway, ActiveStreamRegistry],
})
export class RealtimeModule {}
