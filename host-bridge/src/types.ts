export interface BridgeMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequestBody {
  messages: BridgeMessage[];
  model?: string;
}

/** Mirrors backend's `AiStreamEvent` (`backend/src/ai/ai-provider.interface.ts`) exactly
 * — the backend providers forward these lines straight through with no translation. */
export type BridgeEvent =
  | { type: 'token'; delta: string }
  | {
      type: 'done';
      finishReason: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string };
