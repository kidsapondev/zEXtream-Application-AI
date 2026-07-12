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

/** Token counts for one exchange, when the upstream provider reports them. */
export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AiStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'done'; finishReason: string; usage?: AiTokenUsage }
  | { type: 'error'; message: string };

export interface AiProvider {
  readonly key: AiProviderKey;
  streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent>;
}
