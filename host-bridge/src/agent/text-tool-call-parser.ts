/**
 * Recovers tool calls a model emitted as plain text instead of in Ollama's structured
 * `message.tool_calls` field.
 *
 * Required for the model this machine actually runs. Verified by hand against Ollama
 * 0.32.15 with `qwen2.5-coder:14b` (which `/api/tags` reports as tools-capable): given a
 * correct `tools` payload it produces the right call but emits it as bare JSON in
 * `message.content`, identically with `stream: true` and `stream: false`:
 *
 *     {"name": "read_file", "arguments": {"path": "backend/package.json"}}
 *
 * That model's Ollama template only parses a call back into `tool_calls` when it is
 * wrapped in `<tool_call></tool_call>` delimiters, which the model does not emit — so
 * Ollama passes the text straight through and `tool_calls` stays empty. Without this,
 * `local_code_agent` would answer with raw JSON and never touch a file.
 *
 * This is a deliberate twin of `backend/src/ai/providers/text-tool-call-parser.ts`, which
 * solves the same problem for the web-chat loop. They are not shared: backend runs in
 * Docker and host-bridge runs on the host with a plain `tsc` build rooted at `src/`, so
 * neither can import the other's file. **Fix bugs in both.** The backend twin additionally
 * carries streaming-only buffering logic that has no meaning here, since this loop calls
 * Ollama with `stream: false` and always has the whole message in hand.
 *
 * Conservative by design: a call is only recovered when its `name` matches a tool actually
 * offered, so a model legitimately answering with JSON is never mistaken for a tool call.
 */

interface RecoveredToolCall {
  function: { name: string; arguments: unknown };
}

const TOOL_CALL_TAG = /<\/?tool_call>/g;
const JSON_FENCE = /^```(?:json)?\s*|\s*```$/g;

interface RawCall {
  name?: unknown;
  arguments?: unknown;
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
): RecoveredToolCall | null {
  if (typeof raw.name !== 'string' || !validNames.has(raw.name)) return null;

  let args = raw.arguments;
  // Some models double-encode the arguments object as a string. The loop's own
  // parseArguments() tolerates the same thing for the structured path.
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    // A call with no arguments at all is legitimate (list_files takes none).
    if (raw.arguments !== undefined) return null;
    args = {};
  }
  return { function: { name: raw.name, arguments: args } };
}

/**
 * Extracts every tool call encoded in `text`, or an empty array when it contains none.
 * `validNames` is the set of tools offered on this request — a name outside it is treated
 * as prose, not as a call.
 */
export function parseTextToolCalls(
  text: string,
  validNames: Set<string>,
): RecoveredToolCall[] {
  if (validNames.size === 0) return [];

  const direct = parseCandidate(text, validNames);
  if (direct.length > 0) return direct;

  // Nothing at the top level. Models frequently narrate first and *then* emit the call
  // inside a fence — observed with qwen2.5-coder:14b, which answered with a paragraph of
  // explanation followed by a ```json block containing a perfectly well-formed call. The
  // edge-anchored cleaning in parseCandidate cannot see that, so the whole delegation
  // silently did nothing: the model believed it had called a tool, and no file was written.
  for (const block of embeddedBlocks(text)) {
    const calls = parseCandidate(block, validNames);
    if (calls.length > 0) return calls;
  }
  return [];
}

/** Contents of every fenced block and every `<tool_call>` block, wherever they appear. */
function embeddedBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)```/g)) {
    if (match[1].trim()) blocks.push(match[1]);
  }
  for (const match of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    if (match[1].trim()) blocks.push(match[1]);
  }
  return blocks;
}

function parseCandidate(
  text: string,
  validNames: Set<string>,
): RecoveredToolCall[] {
  const cleaned = text
    .replace(TOOL_CALL_TAG, '')
    .trim()
    .replace(JSON_FENCE, '')
    .trim();
  if (cleaned === '') return [];

  if (cleaned.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      const calls = parsed
        .map((entry) => toToolCall(entry as RawCall, validNames))
        .filter((call): call is RecoveredToolCall => call !== null);
      return calls.length === parsed.length ? calls : [];
    } catch {
      return [];
    }
  }

  const chunks = splitJsonObjects(cleaned);
  if (chunks.length === 0) return [];

  const calls: RecoveredToolCall[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      return [];
    }
    const call = toToolCall(parsed as RawCall, validNames);
    // All-or-nothing: if any candidate object isn't a valid call, the text as a whole is
    // treated as prose. Half-recovering would both fire an unintended tool and swallow the
    // rest of the message.
    if (!call) return [];
    calls.push(call);
  }
  return calls;
}
