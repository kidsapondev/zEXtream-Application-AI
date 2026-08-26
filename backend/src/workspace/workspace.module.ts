import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { WorkspaceController } from './workspace.controller';

/**
 * Re-exposes the workspace the AI tool loop already reaches, this time to the browser.
 *
 * Imports `AiModule` rather than re-registering the bridge client: one client, one set of
 * timeouts, one place where the token and URL are read. Two instances would be two chances
 * for the UI and the model to disagree about whether the workspace is configured.
 */
@Module({
  imports: [AiModule],
  controllers: [WorkspaceController],
})
export class WorkspaceModule {}
