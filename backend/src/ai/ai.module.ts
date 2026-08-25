import { Module } from '@nestjs/common';
import { OllamaProvider } from './providers/ollama.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AiProviderFactory } from './ai-provider.factory';
import { CircuitBreakerService } from './circuit-breaker.service';
import { WorkspaceBridgeClient } from './tools/workspace-bridge.client';
import { WorkspaceToolsService } from './tools/workspace-tools.service';

@Module({
  providers: [
    OllamaProvider,
    ClaudeProvider,
    OpenAiProvider,
    AiProviderFactory,
    CircuitBreakerService,
    // Injected into OllamaProvider only. Registering them unconditionally is safe and
    // deliberate: with WORKSPACE_BRIDGE_URL unset, WorkspaceToolsService.isEnabled()
    // returns false and the provider never sends a `tools` field, so a deployment that
    // hasn't opted into host filesystem access pays nothing for these being wired up.
    WorkspaceBridgeClient,
    WorkspaceToolsService,
  ],
  exports: [AiProviderFactory, WorkspaceToolsService],
})
export class AiModule {}
