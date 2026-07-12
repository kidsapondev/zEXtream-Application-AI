import { Request, Response } from 'express';
import { config } from './config';
import { buildPrompt } from './prompt';
import { runProcess } from './process-runner';
import { BridgeEvent, ChatRequestBody } from './types';

const STATUS_TIMEOUT_MS = 10_000;

export async function codexStatus(_req: Request, res: Response): Promise<void> {
  const result = await runProcess(
    config.codexExePath,
    ['login', 'status'],
    config.neutralCwd,
    STATUS_TIMEOUT_MS,
  );
  // Confirmed by hand: `codex login status` writes its "Logged in using ChatGPT" text
  // to stderr, not stdout, when spawned non-interactively via child_process (easy to
  // miss testing by hand in a shell with `2>&1`, which hides which stream it's really
  // on) — check both rather than assume one.
  const output = `${result.stdout}${result.stderr}`;
  res.json({
    available: result.code === 0 && output.includes('Logged in'),
  });
}

interface CodexItemCompletedEvent {
  type: 'item.completed';
  item: { type: string; text?: string };
}

interface CodexTurnCompletedEvent {
  type: 'turn.completed';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens?: number;
  };
}

interface CodexErrorEvent {
  type: 'error' | 'turn.failed';
  message?: string;
  error?: { message?: string };
}

type CodexEvent =
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent
  | CodexErrorEvent
  | { type: string };

export async function codexChat(req: Request, res: Response): Promise<void> {
  const body = req.body as ChatRequestBody;
  const { systemPrompt, promptText } = buildPrompt(body.messages);
  const fullPrompt = `${systemPrompt}\n\n${promptText}`;
  const args = [
    'exec',
    fullPrompt,
    '--json',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    config.neutralCwd,
  ];
  if (body.model) args.push('--model', body.model);

  const result = await runProcess(
    config.codexExePath,
    args,
    config.neutralCwd,
    config.chatTimeoutMs,
  );

  res.setHeader('Content-Type', 'application/x-ndjson');
  const write = (event: BridgeEvent) => res.write(`${JSON.stringify(event)}\n`);

  if (result.timedOut) {
    write({ type: 'error', message: 'codex CLI timed out' });
    res.end();
    return;
  }

  let text = '';
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let errorMessage: string | undefined;

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    if (event.type === 'item.completed') {
      const item = (event as CodexItemCompletedEvent).item;
      if (item.type === 'agent_message' && item.text) text = item.text;
    } else if (event.type === 'turn.completed') {
      const turnUsage = (event as CodexTurnCompletedEvent).usage;
      if (turnUsage) {
        // OpenAI-style usage: `cached_input_tokens` is a breakdown *within*
        // `input_tokens`, not additive (unlike Anthropic's cache accounting in
        // claude.ts) — reasoning tokens are generated output, so they count toward
        // outputTokens.
        usage = {
          inputTokens: turnUsage.input_tokens,
          outputTokens:
            turnUsage.output_tokens + (turnUsage.reasoning_output_tokens ?? 0),
        };
      }
    } else if (event.type === 'error' || event.type === 'turn.failed') {
      const err = event as CodexErrorEvent;
      errorMessage = err.error?.message ?? err.message ?? 'codex CLI reported an error';
    }
  }

  if (errorMessage) {
    write({ type: 'error', message: errorMessage });
  } else if (!text) {
    write({
      type: 'error',
      message: `codex CLI produced no response (exit ${result.code}): ${result.stderr.slice(0, 500)}`,
    });
  } else {
    write({ type: 'token', delta: text });
    write({ type: 'done', finishReason: 'stop', usage });
  }
  res.end();
}
