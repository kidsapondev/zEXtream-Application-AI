import { Controller, Delete, Get, Param } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator';

@Controller('settings/memory')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.memoryService.list(user.id);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.memoryService.remove(user.id, id);
    return { success: true };
  }

  @Delete()
  async removeAll(@CurrentUser() user: AuthenticatedUser) {
    await this.memoryService.removeAll(user.id);
    return { success: true };
  }
}
