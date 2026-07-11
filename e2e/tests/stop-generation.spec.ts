import { test, expect } from '@playwright/test';
import { registerNewUser, createNewChat, sendComposerMessage } from './helpers';

/**
 * plan.md Test strategy → Browser E2E: "Stop generation".
 *
 * OLLAMA_BASE_URL is an always-unreachable port for this whole suite (see
 * playwright.config.ts), so there is no real token stream to interrupt —
 * per the task brief, the point here is exercising the UI's Stop control
 * and the resulting composer/message state, not proving the abort mechanics
 * themselves (those are covered end to end against a real hanging provider
 * in backend/test/chat-stop.e2e-spec.ts). Because the unreachable provider
 * fails fast, the "streaming" window the Stop button appears in can be very
 * short or may already be gone by the time this test looks for it — the
 * test tolerates both orderings (click Stop if it's still there; otherwise
 * just confirm the message reaches a final, non-stuck state on its own) and
 * asserts the composer is left in a normal, reusable state afterward either
 * way, which is the behavior that actually matters to a user.
 */
test('Stop is clickable while generating (or the response fails fast on its own), and the composer recovers either way', async ({
  page,
}) => {
  await registerNewUser(page, 'stop-gen');
  await createNewChat(page);

  const messageText = `Generate something ${Date.now()}`;
  await sendComposerMessage(page, messageText);

  const stopButton = page.getByRole('button', { name: 'Stop generating' });

  const stopAppeared = await stopButton
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (stopAppeared) {
    await stopButton.click();
  }

  // Whichever path it took (user-initiated stop, or the provider failing on
  // its own), the assistant message must settle into a final, visible state
  // — never stuck showing "generating…" — and the composer must be usable
  // again (Send re-enabled once there's text in the box).
  await expect(page.locator('.message__streaming')).toHaveCount(0, { timeout: 10_000 });

  const composerInput = page.locator('.chat-thread__composer input[name="draft"]');
  const sendButton = page.locator('.chat-thread__composer button[type="submit"]');
  await composerInput.fill('a follow-up message');
  await expect(sendButton).toBeEnabled();
});
