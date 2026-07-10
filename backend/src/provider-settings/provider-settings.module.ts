import { Module } from '@nestjs/common';
import { ApiKeyEncryptionService } from './api-key-encryption.service';
import { ProviderSettingsController } from './provider-settings.controller';
import { ProviderSettingsService } from './provider-settings.service';

@Module({
  controllers: [ProviderSettingsController],
  providers: [ApiKeyEncryptionService, ProviderSettingsService],
  exports: [ProviderSettingsService],
})
export class ProviderSettingsModule {}
