import { Request, Response } from 'express';
import { config } from './config';
import { buildPrompt } from './prompt';
import { runProcess } from './process-runner';
import { BridgeEvent, ChatRequestBody } from './types';

const DEFAULT_MODEL = 'sonnet';
/** `claude auth status` is free (local-only, no model call) — unlike a real chat
 * invocation, safe to hit on every dashboard poll. */
const STATUS_TIMEOUT_MS = 10_000;

interface ClaudeAuthStatus {
  loggedIn?: boolean;
}

export async function claudeStatus(_req: Request, res: Response): Promise<void> {
  const result = await runProcess(
    config.claudeExePath,
    ['auth', 'status'],
    config.neutralCwd,
    STATUS_TIMEOUT_MS,
  );
  let loggedIn = false;
  try {
    const parsed = JSON.parse(result.stdout) as ClaudeAuthStatus;
    loggedIn = parsed.loggedIn === true;
  } catch {
    // Unparseable output (CLI missing, crashed, unexpected format) — treat as unavailable.
  }
  res.json({ available: result.code === 0 && loggedIn });
}

interface ClaudeJsonResult {
  is_error: boolean;
  result: string;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
}

export async function claudeChat(req: Request, res: Response): Promise<void> {
  const body = req.body as ChatRequestBody;
  const { systemPrompt, promptText } = buildPrompt(body.messages);
  const args = [
    '-p',
    promptText,
    '--output-format',
    'json',
    '--tools',
    '',
    '--append-system-prompt',
    systemPrompt,
    '--model',
    body.model ?? DEFAULT_MODEL,
  ];

  const result = await runProcess(
    config.claudeExePath,
    args,
    config.neutralCwd,
    config.chatTimeoutMs,
  );

  res.setHeader('Content-Type', 'application/x-ndjson');
  const write = (event: BridgeEvent) => res.write(`${JSON.stringify(event)}\n`);

  if (result.timedOut) {
    write({ type: 'error', message: 'claude CLI timed out' });
    res.end();
    return;
  }

  try {
    const parsed = JSON.parse(result.stdout) as ClaudeJsonResult;
    if (parsed.is_error) {
      write({ type: 'error', message: parsed.result || 'claude CLI reported an error' });
    } else {
      write({ type: 'token', delta: parsed.result });
      // Anthropic's usage object reports fresh input, cache-write, and cache-read
      // tokens as three genuinely separate (additive) pools, not one figure with a
      // breakdown — all three represent real tokens the model processed, so all three
      // count toward the reported input total.
      const usage = parsed.usage;
      write({
        type: 'done',
        finishReason: 'stop',
        usage: usage
          ? {
              inputTokens:
                usage.input_tokens +
                usage.cache_creation_input_tokens +
                usage.cache_read_input_tokens,
              outputTokens: usage.output_tokens,
            }
          : undefined,
      });
    }
  } catch {
    write({
      type: 'error',
      message: `claude CLI returned unparseable output (exit ${result.code}): ${result.stderr.slice(0, 500)}`,
    });
  }
  res.end();
}
