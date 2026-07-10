import { Module } from '@nestjs/common';
import { OllamaProvider } from './providers/ollama.provider';
import { AiProviderFactory } from './ai-provider.factory';

@Module({
  providers: [OllamaProvider, AiProviderFactory],
  exports: [AiProviderFactory],
})
export class AiModule {}
