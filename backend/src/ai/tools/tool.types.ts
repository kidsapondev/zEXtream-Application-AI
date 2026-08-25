/**
 * Ollama's `/api/chat` tool-calling wire format (see
 * https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools) — this
 * is Ollama's own dialect, not the OpenAI/Anthropic tool schema, though it happens to look
 * similar. `WorkspaceToolsService.definitions()` returns these directly in the `tools`
 * array of the chat request body, and the model echoes `function.name` /
 * `function.arguments` back in `OllamaToolCall` when it wants to invoke one.
 */
export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<
        string,
        { type: string; description: string; items?: { type: string } }
      >;
      required: string[];
    };
  };
}

/**
 * What Ollama sends back in an assistant message's `tool_calls` array once it decides to
 * invoke a tool. Note `arguments` is typed as a plain object per Ollama's documented
 * contract, but in practice models sometimes emit it as a JSON-encoded string instead (see
 * the coercion in `WorkspaceToolsService.execute()`) — that's an observed quirk of the
 * local model, not something this type should pretend is normal.
 */
export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * What the tool layer hands back to the model, plus a one-line human-readable summary the
 * provider streams into the chat so the user can see what the model did. `execute()` never
 * throws (see WorkspaceToolsService) — a failed tool call is still a `ToolExecutionResult`
 * with `ok: false`, so the model can read the error in `content` and try something else on
 * its next turn instead of the whole chat stream dying.
 */
export interface ToolExecutionResult {
  ok: boolean;
  /** Fed back to the model as the `tool` message content. */
  content: string;
  /** Short, user-facing, e.g. `write_file(src/app.ts) → 412 bytes`. */
  summary: string;
}
