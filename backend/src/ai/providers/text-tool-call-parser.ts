import { OllamaToolCall } from '../tools/tool.types';

/**
 * Recovers tool calls that a model emitted as plain text instead of in Ollama's
 * structured `message.tool_calls` field.
 *
 * This is not a hypothetical robustness measure — it is required for the model this
 * deployment actually runs. Verified by hand against Ollama 0.32.15 with
 * `qwen2.5-coder:14b` (which `/api/tags` reports as having the `tools` capability):
 * given a correct `tools` payload, the model reliably produces the right call but emits
 * it as bare JSON in `message.content`:
 *
 *     {"name": "read_file", "arguments": {"path": "backend/package.json"}}
 *
 * while that model's Ollama template only parses a call back into `tool_calls` when it
 * is wrapped in `<tool_call></tool_call>` tags. The wrapper is missing, so Ollama leaves
 * the text in `content` and `tool_calls` never appears. Reproduced with and without a
 * system prompt. Without this parser the tool loop would silently never fire, and the
 * user would just see raw JSON in the chat — the failure mode is invisible, not loud.
 *
 * Deliberately conservative: a call is only recovered when its `name` matches a tool
 * actually offered on this request. Anything else is left alone as ordinary prose, so a
 * model legitimately answering with a JSON snippet is never mistaken for a tool call.
 */

/** Tags/fences models wrap the JSON in when they wrap it at all. */
const TOOL_CALL_TAG = /<\/?tool_call>/g;
const JSON_FENCE = /^```(?:json)?\s*|\s*```$/g;

interface RawCall {
  name?: unknown;
  arguments?: unknown;
}

/**
 * True when text so far could still turn out to be a text-encoded tool call, and so must
 * be buffered rather than streamed to the user. Checked against the first non-whitespace
 * characters of the turn: every observed shape starts the response with one of these.
 *
 * A bare "```" (a normal fenced code answer) deliberately does NOT match — those are the
 * common case and must keep streaming token by token. The cost of the shapes that do
 * match is only that such an answer arrives in one chunk instead of incrementally.
 */
export function looksLikeToolCallStart(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed === '') return true;
  return (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('```json') ||
    '<tool_call>'.startsWith(trimmed.slice(0, 11)) ||
    trimmed.startsWith('<tool_call>')
  );
}

/** Splits concatenated top-level JSON objects (`{...}{...}` or newline-separated) apart. */
function splitJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function toToolCall(
  raw: RawCall,
  validNames: Set<string>,
): OllamaToolCall | null {
  if (typeof raw.name !== 'string' || !validNames.has(raw.name)) return null;

  let args = raw.arguments;
  // Some models double-encode the arguments object as a string; the structured path in
  // WorkspaceToolsService tolerates the same thing, for the same reason.
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    // A call with no arguments at all is legitimate (list_files takes none).
    args = raw.arguments === undefined ? {} : null;
    if (args === null) return null;
  }
  return {
    function: { name: raw.name, arguments: args as Record<string, unknown> },
  };
}

/**
 * Extracts every tool call encoded in `text`, or an empty array when it contains none.
 * `validNames` is the set of tools offered on this request — a name outside it is treated
 * as prose, not as a call.
 */
export function parseTextToolCalls(
  text: string,
  validNames: Set<string>,
): OllamaToolCall[] {
  if (validNames.size === 0) return [];

  const cleaned = text
    .replace(TOOL_CALL_TAG, '')
    .trim()
    .replace(JSON_FENCE, '')
    .trim();
  if (cleaned === '') return [];

  // An array of calls, which some models emit when asked for more than one.
  if (cleaned.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        const calls = parsed
          .map((entry) => toToolCall(entry as RawCall, validNames))
          .filter((call): call is OllamaToolCall => call !== null);
        return calls.length === parsed.length ? calls : [];
      }
    } catch {
      return [];
    }
    return [];
  }

  const chunks = splitJsonObjects(cleaned);
  if (chunks.length === 0) return [];

  const calls: OllamaToolCall[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      return [];
    }
    const call = toToolCall(parsed as RawCall, validNames);
    // All-or-nothing: if any candidate object isn't a valid call, the text as a whole is
    // treated as prose. Half-recovering a response would both fire an unintended tool and
    // swallow the rest of the message.
    if (!call) return [];
    calls.push(call);
  }
  return calls;
}
