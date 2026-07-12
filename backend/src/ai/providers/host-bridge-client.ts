import { AiStreamEvent } from '../ai-provider.interface';

/**
 * The host-bridge's NDJSON response body is already shaped as `AiStreamEvent` (see
 * `host-bridge/src/types.ts`'s `BridgeEvent`, which mirrors this type exactly) — each
 * line is parsed and re-yielded as-is, no translation needed. Shared by `ClaudeProvider`
 * and `OpenAiProvider`, which both talk to the same bridge (for claude.exe and codex.exe
 * respectively — see docs/deployment.md for why this is a separate host-side service
 * rather than a normal HTTP API call).
 */
export async function* readBridgeEvents(
  body: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal,
): AsyncIterable<AiStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as AiStreamEvent;
        } catch {
          // Skip a single malformed line instead of failing the whole stream.
        }
      }
    }
  } catch (err) {
    if (abortSignal.aborted) {
      yield { type: 'done', finishReason: 'stopped' };
    } else {
      yield {
        type: 'error',
        message: `Host-bridge stream error: ${(err as Error).message}`,
      };
    }
  }
}
