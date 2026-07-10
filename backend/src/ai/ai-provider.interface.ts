export type AiProviderKey = 'ollama' | 'claude' | 'openai';

export type AiMessageRole = 'user' | 'assistant' | 'system';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiChatRequest {
  messages: AiMessage[];
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal: AbortSignal;
}

export type AiStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string };

export interface AiProvider {
  readonly key: AiProviderKey;
  streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent>;
}
