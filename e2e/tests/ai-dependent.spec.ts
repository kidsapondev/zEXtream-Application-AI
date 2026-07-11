import { test } from '@playwright/test';

/**
 * plan.md Test strategy → Browser E2E lists these two scenarios:
 *   - Send prompt → เห็น token streaming
 *   - Generate code → เห็น Monaco progressive stream
 *
 * Both require a real AI backend actually producing a response — there is
 * no reachable Ollama (or any other provider) in this environment (this
 * whole suite deliberately points OLLAMA_BASE_URL at an always-unreachable
 * port; see playwright.config.ts). Faking "streaming" by mocking the
 * WebSocket events would not test anything real (the actual parser/render
 * pipeline never runs), so these are left as genuinely skipped rather than
 * papered over with a mocked pass.
 *
 * To run them for real: point OLLAMA_BASE_URL (in playwright.config.ts's
 * BACKEND_ENV) at a reachable Ollama instance with a pulled model (e.g.
 * `ollama pull qwen2.5-coder:14b`, matching DEFAULT_OLLAMA_MODEL in
 * chat-workspace.component.ts), remove `.skip`, and fill in the assertions
 * described in each test body below.
 */

test.skip(
  'send a prompt and see token-by-token streaming render in the chat thread',
  async ({ page: _page }) => {
    // With a reachable Ollama:
    // 1. registerNewUser + createNewChat + sendComposerMessage (see helpers.ts).
    // 2. Assert `.message__streaming` appears on the assistant message.
    // 3. Assert `.message__content` for that message grows (poll its
    //    textContent length increasing) while `.message__streaming` is present.
    // 4. Assert `.message__streaming` disappears and final content is stable
    //    once the response completes.
  },
);

test.skip(
  'a prompt that produces a fenced code block shows progressive Monaco streaming',
  async ({ page: _page }) => {
    // With a reachable Ollama and a prompt engineered to trigger the
    // ```language:path fence convention (see SYSTEM_PROMPT in chat.gateway.ts):
    // 1. Send a prompt like "write a hello world function in
    //    typescript:src/hello.ts".
    // 2. Assert the code editor panel mounts (artifactStore.hasArtifacts()
    //    becomes true — see chat-workspace.component.html's
    //    workspace-split__editor panel) once `artifact:stream:start` fires.
    // 3. Assert the Monaco editor's visible content grows across
    //    `artifact:stream:chunk` events (Monaco renders into a
    //    `.monaco-editor` container — poll its rendered line count/text).
    // 4. Assert the artifact is saved (a file tab appears, matching the
    //    fence's declared filename) once `artifact:stream:end` fires.
  },
);
