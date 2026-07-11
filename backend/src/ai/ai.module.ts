import { Module } from '@nestjs/common';
import { OllamaProvider } from './providers/ollama.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AiProviderFactory } from './ai-provider.factory';
import { CircuitBreakerService } from './circuit-breaker.service';

@Module({
  providers: [
    OllamaProvider,
    ClaudeProvider,
    OpenAiProvider,
    AiProviderFactory,
    CircuitBreakerService,
  ],
  exports: [AiProviderFactory],
})
export class AiModule {}
