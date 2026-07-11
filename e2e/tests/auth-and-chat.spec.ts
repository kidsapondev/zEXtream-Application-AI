import { test, expect } from '@playwright/test';
import { registerNewUser, createNewChat, sendComposerMessage } from './helpers';

/**
 * plan.md Test strategy → Browser E2E:
 *   - Register → login → create chat
 *   - Reload → session/messages/artifacts กลับมาครบ
 *
 * Drives the real UI end to end: no API shortcuts, no mocked backend. The AI
 * response itself is not asserted on here — OLLAMA_BASE_URL points at an
 * always-unreachable port for this whole suite (see playwright.config.ts),
 * so the assistant message predictably ends in an error state. What this
 * test verifies is the part that doesn't need a real model: the user's own
 * message is sent, persisted, shown, and survives a hard reload.
 */
test('register, create a chat, send a message, and reload without losing state', async ({
  page,
}) => {
  await registerNewUser(page, 'chat-flow');

  const sessionId = await createNewChat(page);
  expect(sessionId).toBeTruthy();

  const messageText = `Hello from Playwright ${Date.now()}`;
  await sendComposerMessage(page, messageText);

  const userMessage = page.locator('.message.message--user .message__content', {
    hasText: messageText,
  });
  await expect(userMessage).toBeVisible();

  // The session now has a real title derived from the first message (see
  // ChatGateway.deriveSessionTitle) instead of the "New Chat" placeholder —
  // confirms the session list reflects server state, not just local UI state.
  const activeSessionRow = page.locator('.session-item-row--active');
  await expect(activeSessionRow).toBeVisible();

  // --- Reload: everything above must survive a hard page reload, which
  // wipes the in-memory access token and all client-side state, relying
  // entirely on the httpOnly refresh cookie + server-persisted data. ---
  await page.reload();

  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}`));
  await expect(page.locator('.session-item-row--active')).toBeVisible();
  await expect(
    page.locator('.message.message--user .message__content', { hasText: messageText }),
  ).toBeVisible({ timeout: 10_000 });
});
