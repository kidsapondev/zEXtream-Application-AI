import { Injectable, OnModuleInit } from '@nestjs/common';
import { AiProvider, AiProviderKey } from './ai-provider.interface';
import { OllamaProvider } from './providers/ollama.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';

@Injectable()
export class AiProviderFactory implements OnModuleInit {
  private readonly providers = new Map<AiProviderKey, AiProvider>();

  constructor(
    private readonly ollamaProvider: OllamaProvider,
    private readonly claudeProvider: ClaudeProvider,
    private readonly openaiProvider: OpenAiProvider,
  ) {}

  onModuleInit() {
    this.providers.set(this.ollamaProvider.key, this.ollamaProvider);
    this.providers.set(this.claudeProvider.key, this.claudeProvider);
    this.providers.set(this.openaiProvider.key, this.openaiProvider);
  }

  hasProvider(key: AiProviderKey): boolean {
    return this.providers.has(key);
  }

  getProvider(key: AiProviderKey): AiProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`No AI provider registered for key "${key}"`);
    }
    return provider;
  }
}
