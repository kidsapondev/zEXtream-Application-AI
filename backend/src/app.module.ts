import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ChatModule } from './chat/chat.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { ProviderSettingsModule } from './provider-settings/provider-settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Default rate limit for the whole REST API. Individual auth endpoints
    // override this with tighter, purpose-specific limits via @Throttle().
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    PrismaModule,
    UsersModule,
    AuthModule,
    ChatModule,
    ArtifactsModule,
    ProviderSettingsModule,
    RealtimeModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registration order matters: JwtAuthGuard (registered in AuthModule) runs
    // first, then this one. Both are APP_GUARD providers, so canActivate on
    // every guard must pass for a request to proceed — @Public() routes skip
    // the JWT check but still go through the throttler below.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
