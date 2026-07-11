import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { UpsertProviderCredentialDto } from './dto/upsert-provider-credential.dto';
import { ProviderSettingsService } from './provider-settings.service';

@Controller('settings/providers')
export class ProviderSettingsController {
  constructor(
    private readonly providerSettingsService: ProviderSettingsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.providerSettingsService.listForUser(user.id);
  }

  @Put(':provider')
  async upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') provider: string,
    @Body() dto: UpsertProviderCredentialDto,
  ) {
    await this.providerSettingsService.upsertApiKey(
      user.id,
      provider,
      dto.apiKey,
    );
    return { success: true };
  }

  @Delete(':provider')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') provider: string,
  ) {
    await this.providerSettingsService.removeApiKey(user.id, provider);
    return { success: true };
  }

  @Post(':provider/test')
  testConnection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider') provider: string,
  ) {
    return this.providerSettingsService.testConnection(user.id, provider);
  }
}
