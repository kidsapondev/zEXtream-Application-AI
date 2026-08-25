import {
  looksLikeToolCallStart,
  parseTextToolCalls,
} from './text-tool-call-parser';

const TOOLS = new Set(['read_file', 'write_file', 'list_files']);

describe('looksLikeToolCallStart', () => {
  it('buffers while nothing has arrived yet', () => {
    expect(looksLikeToolCallStart('')).toBe(true);
    expect(looksLikeToolCallStart('   \n')).toBe(true);
  });

  it('buffers the shapes a text-encoded tool call actually starts with', () => {
    expect(looksLikeToolCallStart('{"name"')).toBe(true);
    expect(looksLikeToolCallStart('  \n{')).toBe(true);
    expect(looksLikeToolCallStart('<tool_call>')).toBe(true);
    expect(looksLikeToolCallStart('<tool')).toBe(true);
    expect(looksLikeToolCallStart('```json')).toBe(true);
    expect(looksLikeToolCallStart('[')).toBe(true);
  });

  it('streams ordinary prose and ordinary code fences immediately', () => {
    expect(looksLikeToolCallStart('Sure, here')).toBe(false);
    // The common case: a normal fenced code answer must not be held back.
    expect(looksLikeToolCallStart('```ts')).toBe(false);
    expect(looksLikeToolCallStart('```')).toBe(false);
  });
});

describe('parseTextToolCalls', () => {
  it('recovers the exact shape qwen2.5-coder emits (bare JSON, no wrapper)', () => {
    const text =
      '{"name": "read_file", "arguments": {"path": "backend/package.json"}}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([
      {
        function: {
          name: 'read_file',
          arguments: { path: 'backend/package.json' },
        },
      },
    ]);
  });

  it('recovers a call wrapped in tool_call tags', () => {
    const text =
      '<tool_call>\n{"name": "list_files", "arguments": {}}\n</tool_call>';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([
      { function: { name: 'list_files', arguments: {} } },
    ]);
  });

  it('recovers a call wrapped in a json code fence', () => {
    const text =
      '```json\n{"name": "list_files", "arguments": {"path": "src"}}\n```';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([
      { function: { name: 'list_files', arguments: { path: 'src' } } },
    ]);
  });

  it('recovers several calls emitted back to back', () => {
    const text =
      '{"name": "read_file", "arguments": {"path": "a.ts"}}\n{"name": "read_file", "arguments": {"path": "b.ts"}}';

    expect(parseTextToolCalls(text, TOOLS)).toHaveLength(2);
  });

  it('recovers calls emitted as a JSON array', () => {
    const text =
      '[{"name": "read_file", "arguments": {"path": "a.ts"}}, {"name": "list_files", "arguments": {}}]';

    expect(parseTextToolCalls(text, TOOLS)).toHaveLength(2);
  });

  it('accepts double-encoded arguments', () => {
    const text =
      '{"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([
      { function: { name: 'read_file', arguments: { path: 'a.ts' } } },
    ]);
  });

  it('treats an unknown tool name as prose, not as a call', () => {
    const text = '{"name": "rm_rf", "arguments": {"path": "/"}}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([]);
  });

  it('leaves a genuine JSON answer alone', () => {
    // A model legitimately answering with JSON must never be mistaken for a tool call.
    const text = '{"port": 3000, "host": "localhost"}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([]);
  });

  it('is all-or-nothing when only some objects are valid calls', () => {
    const text =
      '{"name": "read_file", "arguments": {"path": "a.ts"}}\n{"unrelated": true}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([]);
  });

  it('returns nothing when the text is not JSON at all', () => {
    expect(parseTextToolCalls('Here is your answer.', TOOLS)).toEqual([]);
    expect(parseTextToolCalls('', TOOLS)).toEqual([]);
  });

  it('recovers nothing when no tools were offered on the request', () => {
    const text = '{"name": "read_file", "arguments": {"path": "a.ts"}}';

    expect(parseTextToolCalls(text, new Set())).toEqual([]);
  });

  it('is not confused by braces inside string arguments', () => {
    const text =
      '{"name": "write_file", "arguments": {"path": "a.json", "content": "{\\"a\\": 1}"}}';

    expect(parseTextToolCalls(text, TOOLS)).toEqual([
      {
        function: {
          name: 'write_file',
          arguments: { path: 'a.json', content: '{"a": 1}' },
        },
      },
    ]);
  });
});
