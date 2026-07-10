import { Injectable, OnModuleInit } from '@nestjs/common';
import { AiProvider, AiProviderKey } from './ai-provider.interface';
import { OllamaProvider } from './providers/ollama.provider';

@Injectable()
export class AiProviderFactory implements OnModuleInit {
  private readonly providers = new Map<AiProviderKey, AiProvider>();

  constructor(private readonly ollamaProvider: OllamaProvider) {}

  onModuleInit() {
    this.providers.set(this.ollamaProvider.key, this.ollamaProvider);
  }

  getProvider(key: AiProviderKey): AiProvider {
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(`No AI provider registered for key "${key}"`);
    }
    return provider;
  }
}
