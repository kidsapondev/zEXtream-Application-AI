import { Injectable } from '@nestjs/common';

interface StreamEntry {
  sessionId: string;
  controller: AbortController;
}

/**
 * Tracks in-flight AI stream `AbortController`s, keyed by the assistant
 * message they belong to, with a secondary index by `sessionId` so every
 * stream belonging to a session can be found/aborted together (e.g. before
 * the session itself is deleted).
 *
 * Concurrency policy: only one stream may be active per chat session at a
 * time. `ChatGateway.onChatSend` calls `hasActiveStream(sessionId)` and
 * rejects a concurrent `chat:send` with a `WsException` before creating any
 * message rows. This is a deliberate product decision, not an incidental
 * limitation: a session's assistant messages, prose tokens and artifact
 * stream events all broadcast into the same Socket.IO room without any
 * per-stream interleaving key, so two simultaneous generations for the same
 * session would interleave tokens/artifact chunks from unrelated responses
 * on the client with no way to tell them apart. Serializing sends per
 * session keeps ordering simple and correct; it does not prevent different
 * sessions (or different users) from streaming concurrently.
 */
@Injectable()
export class ActiveStreamRegistry {
  private readonly controllers = new Map<string, StreamEntry>();
  private readonly bySession = new Map<string, Set<string>>();

  register(messageId: string, sessionId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(messageId, { sessionId, controller });
    let messageIds = this.bySession.get(sessionId);
    if (!messageIds) {
      messageIds = new Set();
      this.bySession.set(sessionId, messageIds);
    }
    messageIds.add(messageId);
    return controller;
  }

  stop(messageId: string): boolean {
    const entry = this.controllers.get(messageId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  release(messageId: string): void {
    const entry = this.controllers.get(messageId);
    if (!entry) return;
    this.controllers.delete(messageId);
    const messageIds = this.bySession.get(entry.sessionId);
    if (!messageIds) return;
    messageIds.delete(messageId);
    if (messageIds.size === 0) {
      this.bySession.delete(entry.sessionId);
    }
  }

  hasActiveStream(sessionId: string): boolean {
    const messageIds = this.bySession.get(sessionId);
    return !!messageIds && messageIds.size > 0;
  }

  /** Aborts every stream registered under `sessionId` and clears them from the registry. */
  stopAllForSession(sessionId: string): void {
    const messageIds = this.bySession.get(sessionId);
    if (!messageIds) return;
    for (const messageId of messageIds) {
      this.controllers.get(messageId)?.controller.abort();
      this.controllers.delete(messageId);
    }
    this.bySession.delete(sessionId);
  }
}
