import { Controller, Get } from '@nestjs/common';
import { ProviderSettingsService } from './provider-settings.service';

@Controller('settings/providers')
export class ProviderSettingsController {
  constructor(
    private readonly providerSettingsService: ProviderSettingsService,
  ) {}

  @Get()
  list() {
    return this.providerSettingsService.list();
  }
}
