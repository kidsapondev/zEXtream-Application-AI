import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiChatRequest,
  AiMessage,
  AiProvider,
  AiStreamEvent,
} from '../ai-provider.interface';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { fetchWithRetry } from './fetch-with-retry';
import { OllamaToolCall, OllamaToolDefinition } from '../tools/tool.types';
import { WorkspaceToolsService } from '../tools/workspace-tools.service';
import {
  looksLikeToolCallStart,
  parseTextToolCalls,
} from './text-tool-call-parser';

/**
 * Ollama's own wire format for a chat message. Deliberately NOT `AiMessage`: the
 * tool-calling loop below has to send back two shapes the provider-agnostic type has no
 * room for — an assistant turn carrying `tool_calls`, and a `tool` role turn carrying
 * one tool's output. Keeping this local to the Ollama provider is on purpose:
 * claude/openai go through the host-bridge CLIs, which have their own built-in tool
 * harnesses, so widening the shared `AiMessage` for a wire detail only one provider
 * speaks would leak Ollama's format into providers that can't use it.
 */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Which tool produced this `role: 'tool'` message. */
  tool_name?: string;
}

interface OllamaChatChunk {
  message?: {
    role: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  /** Only present on the final (`done: true`) chunk. */
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Time allowed to establish the connection (fetch resolving with a response).
 * Generous on purpose: Ollama only loads a model into RAM/VRAM on its first
 * request (or after it's been idle long enough to unload) — for a large
 * local model that cold load alone can take well over 10s before Ollama
 * even starts responding, which a short timeout would misreport as
 * "unreachable" on every first message of a session. Confirmed by hand: a
 * 14B Q4 model (~14.6GB) reproducibly missed a 10s connect timeout on cold
 * load, then answered normally once warm.
 */
export const OLLAMA_CONNECT_TIMEOUT_MS = 90_000;

/** Time allowed between successive stream chunks before the stream is considered stalled. */
export const OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS = 30_000;

/**
 * Hard cap on model -> tool -> model round trips within a single `chat:send`. A local
 * model that misunderstands a tool's result can otherwise loop on it forever (re-reading
 * the same file, retrying the same failing write), and every round trip is a full prompt
 * re-evaluation on the GPU — so an unbounded loop doesn't just hang the request, it pins
 * the card. Eight is enough for a realistic "look around, read two files, write one,
 * verify" sequence while still terminating quickly when the model is stuck.
 */
export const MAX_TOOL_TURNS = 8;

/**
 * One turn's worth of events. `tool-call` never reaches the gateway — `streamChat`
 * consumes it, runs the tool, and feeds the result back into the next turn; only the
 * three `AiStreamEvent` variants are forwarded upstream.
 */
type TurnEvent = AiStreamEvent | { type: 'tool-call'; call: OllamaToolCall };

function toOllamaMessages(messages: AiMessage[]): OllamaMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

/**
 * Inserts `content` as an extra system message directly after the caller's own leading
 * system messages, rather than at index 0 or at the end. The gateway already front-loads
 * its artifact-format instructions plus the user's memory notes as system turns; slotting
 * the workspace policy in beside them keeps every instruction in one contiguous block
 * ahead of the conversation, which is what small local models follow most reliably — a
 * system message stranded after several user/assistant turns is routinely ignored.
 */
function insertSystemMessage(
  messages: OllamaMessage[],
  content: string,
): OllamaMessage[] {
  let index = 0;
  while (index < messages.length && messages[index].role === 'system') {
    index += 1;
  }
  const next = [...messages];
  next.splice(index, 0, { role: 'system', content });
  return next;
}

@Injectable()
export class OllamaProvider implements AiProvider {
  readonly key = 'ollama' as const;
  private readonly baseUrl: string;
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(
    configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly workspaceTools: WorkspaceToolsService,
  ) {
    this.baseUrl = configService.getOrThrow<string>('OLLAMA_BASE_URL');
  }

  /**
   * Runs the model to a final answer, executing any workspace tools it asks for along
   * the way. With workspace tools disabled (the default — see `WorkspaceToolsService`)
   * this collapses to exactly one `runTurn` call and behaves identically to the
   * pre-tool-calling provider.
   */
  async *streamChat(request: AiChatRequest): AsyncIterable<AiStreamEvent> {
    if (this.circuitBreaker.isOpen(this.key)) {
      const retryInSeconds = Math.ceil(
        this.circuitBreaker.cooldownRemainingMs(this.key) / 1000,
      );
      yield {
        type: 'error',
        message: `Ollama is temporarily unavailable after repeated failures; retrying in ~${retryInSeconds}s`,
      };
      return;
    }

    const toolsEnabled = this.workspaceTools.isEnabled();
    const tools = toolsEnabled ? this.workspaceTools.definitions() : undefined;
    let messages = toOllamaMessages(request.messages);
    if (toolsEnabled) {
      messages = insertSystemMessage(
        messages,
        this.workspaceTools.systemPrompt(),
      );
    }

    // Usage is summed across every turn, not taken from the last one: each tool round
    // trip is a separate full evaluation on the GPU, and reporting only the final turn
    // would make a six-tool-call answer look as cheap as a one-liner in the message's
    // stored token count.
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const totalUsage = () =>
      sawUsage ? { inputTokens, outputTokens } : undefined;

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const pendingCalls: OllamaToolCall[] = [];
      let assistantContent = '';
      let finishReason = 'stop';

      for await (const event of this.runTurn(messages, tools, request)) {
        if (event.type === 'token') {
          // Only genuine model output is accumulated here — the tool summaries streamed
          // further down are UI narration, and feeding them back as assistant content
          // would duplicate what the model already receives in its `tool` messages.
          assistantContent += event.delta;
          yield event;
        } else if (event.type === 'tool-call') {
          pendingCalls.push(event.call);
        } else if (event.type === 'error') {
          yield event;
          return;
        } else {
          finishReason = event.finishReason;
          if (event.usage) {
            sawUsage = true;
            inputTokens += event.usage.inputTokens;
            outputTokens += event.usage.outputTokens;
          }
        }
      }

      // `stopped` means the user hit stop mid-turn — honour it even if the model had
      // already emitted tool calls, rather than running side effects on the user's disk
      // for a response they just cancelled.
      if (pendingCalls.length === 0 || finishReason === 'stopped') {
        yield { type: 'done', finishReason, usage: totalUsage() };
        return;
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: assistantContent,
          tool_calls: pendingCalls,
        },
      ];

      for (const call of pendingCalls) {
        if (request.abortSignal.aborted) {
          yield { type: 'done', finishReason: 'stopped', usage: totalUsage() };
          return;
        }

        // execute() is contractually non-throwing: a bad path or a missing argument
        // comes back as `ok: false` and is handed to the model as that tool's output, so
        // it can correct itself on the next turn instead of the whole chat failing.
        const result = await this.workspaceTools.execute(
          call,
          request.abortSignal,
        );

        // Streamed as prose so the user can see every file the model touched. Fenced
        // blocks are what ArtifactStreamParser splits out; a plain quoted line like this
        // passes straight through and lands in the saved transcript as an audit trail.
        yield {
          type: 'token',
          delta: `\n\n> ${result.ok ? '✓' : '✗'} ${result.summary}\n\n`,
        };

        messages = [
          ...messages,
          {
            role: 'tool',
            content: result.content,
            tool_name: call.function.name,
          },
        ];
      }
    }

    yield {
      type: 'error',
      message: `The model kept calling tools without finishing an answer (stopped after ${MAX_TOOL_TURNS} rounds)`,
    };
  }

  /**
   * One `/api/chat` request: streams the model's tokens and collects any tool calls it
   * emits. Ends with exactly one `done` or one `error` event.
   */
  private async *runTurn(
    messages: OllamaMessage[],
    tools: OllamaToolDefinition[] | undefined,
    request: AiChatRequest,
  ): AsyncIterable<TurnEvent> {
    // A single combined signal governs the whole request (connect + body
    // read): either the caller's own abort, a connect-timeout abort, or a
    // stream-inactivity abort ends it. The connect timer is cleared as soon
    // as a response is received so it can never misfire mid-stream; the
    // inactivity timer is (re)armed on every chunk received so a healthy,
    // merely slow stream is never killed, only a stalled one.
    //
    // Deliberately NOT armed yet at this point: Ollama doesn't send response
    // headers until it's ready to start streaming, so a cold model load (see
    // OLLAMA_CONNECT_TIMEOUT_MS above) happens entirely before fetch()
    // resolves — that whole window belongs to the connect timeout. Arming
    // the (much shorter) inactivity timer this early would race the connect
    // timeout and misreport a slow cold load as "stream timed out due to
    // inactivity" instead of "still connecting". It's armed for real right
    // after the connection succeeds, below.
    const connectController = new AbortController();
    const connectTimer = setTimeout(
      () => connectController.abort(),
      OLLAMA_CONNECT_TIMEOUT_MS,
    );
    const inactivityController = new AbortController();
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const armInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => inactivityController.abort(),
        OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS,
      );
    };

    const combinedSignal = AbortSignal.any([
      request.abortSignal,
      connectController.signal,
      inactivityController.signal,
    ]);

    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: request.model,
              messages,
              // JSON.stringify drops undefined keys, so an unconfigured workspace sends
              // no `tools` field at all rather than an explicit null — which older
              // Ollama builds reject outright.
              tools,
              stream: true,
              options: {
                temperature: request.temperature,
              },
            }),
            signal: combinedSignal,
          }),
        combinedSignal,
      );
    } catch (err) {
      clearTimeout(connectTimer);
      // inactivityController can't be the cause here: its timer isn't armed
      // until after the connection succeeds (see below), which by
      // definition hasn't happened if this fetch attempt just threw.
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else if (connectController.signal.aborted) {
        this.circuitBreaker.recordFailure(this.key);
        yield {
          type: 'error',
          message: `Connecting to Ollama timed out after ${OLLAMA_CONNECT_TIMEOUT_MS}ms`,
        };
      } else {
        this.circuitBreaker.recordFailure(this.key);
        yield {
          type: 'error',
          message: `Could not reach Ollama: ${(err as Error).message}`,
        };
      }
      return;
    }
    clearTimeout(connectTimer);

    if (!response.ok || !response.body) {
      // Ollama has no per-user API keys, so unlike Claude/OpenAI every non-2xx
      // status here reflects the shared local instance's own health (a bad
      // model name is the one common exception, hence excluding 4xx here too
      // to avoid opening the circuit over a client-side typo repeated by one
      // session) rather than one user's credentials.
      if (response.status >= 500) {
        this.circuitBreaker.recordFailure(this.key);
      }
      yield {
        type: 'error',
        message: `Ollama returned HTTP ${response.status}`,
      };
      return;
    }

    this.circuitBreaker.recordSuccess(this.key);

    // The connection succeeded and headers are in — now, and only now, does
    // "no data for N seconds" mean a stalled stream rather than a slow/cold
    // connection. See the comment where inactivityController is created.
    armInactivityTimer();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Text-encoded tool-call recovery. See text-tool-call-parser.ts for why this is
    // necessary rather than merely defensive: the model this deployment runs emits its
    // tool calls as bare JSON in `content`, so `tool_calls` never arrives.
    //
    // Content can't be streamed straight through while that's still possible, or the raw
    // JSON would reach the user's screen before we knew it was a call. So the first
    // non-whitespace characters of the turn decide: anything that could be a call is
    // buffered until the turn ends, anything else switches to plain streaming for good.
    // With no tools offered there is nothing to recover, so the mode starts at
    // 'streaming' and this whole mechanism is inert.
    const toolNames = new Set((tools ?? []).map((tool) => tool.function.name));
    let sawStructuredToolCall = false;
    let contentBuffer = '';
    let contentMode: 'undecided' | 'buffering' | 'streaming' =
      toolNames.size === 0 ? 'streaming' : 'undecided';

    /** Resolves whatever is still buffered when the turn ends: either recovered tool
     *  calls, or — when it turned out to be ordinary prose after all — the text itself. */
    const finalizeContent = function* (): Generator<TurnEvent> {
      if (contentMode !== 'buffering' || contentBuffer === '') return;
      if (!sawStructuredToolCall) {
        const recovered = parseTextToolCalls(contentBuffer, toolNames);
        if (recovered.length > 0) {
          for (const call of recovered) {
            yield { type: 'tool-call', call };
          }
          contentBuffer = '';
          return;
        }
      }
      yield { type: 'token', delta: contentBuffer };
      contentBuffer = '';
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armInactivityTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(line) as OllamaChatChunk;
          } catch {
            // A single malformed/non-JSON line does not fail the whole
            // response: Ollama's NDJSON framing means one corrupt line is
            // very unlikely to indicate the rest of the stream is bad, and
            // dropping the whole in-flight assistant message over one bad
            // line is worse UX than silently skipping it and continuing.
            this.logger.warn(`Skipping malformed Ollama stream line: ${line}`);
            continue;
          }
          const content = chunk.message?.content;
          if (content) {
            if (contentMode === 'streaming') {
              yield { type: 'token', delta: content };
            } else {
              contentBuffer += content;
              if (contentMode === 'undecided' && contentBuffer.trim() !== '') {
                if (looksLikeToolCallStart(contentBuffer)) {
                  contentMode = 'buffering';
                } else {
                  contentMode = 'streaming';
                  yield { type: 'token', delta: contentBuffer };
                  contentBuffer = '';
                }
              }
            }
          }
          // Unlike OpenAI's API, Ollama does not stream tool-call arguments as
          // incremental JSON fragments that have to be concatenated — each call arrives
          // whole in a single chunk, so collecting them needs no reassembly buffer.
          for (const call of chunk.message?.tool_calls ?? []) {
            sawStructuredToolCall = true;
            yield { type: 'tool-call', call };
          }
          if (chunk.done) {
            clearTimeout(inactivityTimer);
            yield* finalizeContent();
            yield {
              type: 'done',
              finishReason: chunk.done_reason ?? 'stop',
              usage:
                chunk.prompt_eval_count != null && chunk.eval_count != null
                  ? {
                      inputTokens: chunk.prompt_eval_count,
                      outputTokens: chunk.eval_count,
                    }
                  : undefined,
            };
            return;
          }
        }
      }
      clearTimeout(inactivityTimer);
      yield* finalizeContent();
      yield { type: 'done', finishReason: 'stop' };
    } catch (err) {
      clearTimeout(inactivityTimer);
      if (request.abortSignal.aborted) {
        yield { type: 'done', finishReason: 'stopped' };
      } else if (inactivityController.signal.aborted) {
        yield {
          type: 'error',
          message: `Ollama stream timed out after ${OLLAMA_STREAM_INACTIVITY_TIMEOUT_MS}ms of inactivity`,
        };
      } else {
        yield {
          type: 'error',
          message: `Ollama stream error: ${(err as Error).message}`,
        };
      }
    }
  }
}
