import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { CodeArtifactDto } from '@app/shared-types';
import { SocketService } from '../../core/socket.service';

interface StreamingArtifact {
  tempId: string;
  sessionId: string;
  messageId: string;
  filename: string;
  language: string;
  content: string;
}

@Injectable({ providedIn: 'root' })
export class ArtifactStore {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly saveDebounceMs = 500;
  private readonly pendingSaves = new Map<
    string,
    { artifactId: string; content: string; timer: ReturnType<typeof setTimeout> }
  >();
  private loadGeneration = 0;

  /** Latest revision of each file, keyed by filename. */
  private readonly artifacts = signal<Map<string, CodeArtifactDto>>(new Map());
  /** Artifacts currently being written by the AI, keyed by tempId. */
  private readonly streaming = signal<Map<string, StreamingArtifact>>(new Map());

  readonly openTabs = signal<string[]>([]);
  readonly activeFilename = signal<string | null>(null);
  readonly currentSessionId = signal<string | null>(null);

  readonly files = computed(() => {
    const finished = [...this.artifacts().values()].map((a) => ({
      filename: a.filename,
      language: a.language,
      content: a.content,
      streaming: false,
      id: a.id,
    }));
    const inProgress = [...this.streaming().values()]
      .filter((s) => !this.artifacts().has(s.filename))
      .map((s) => ({
        filename: s.filename,
        language: s.language,
        content: s.content,
        streaming: true,
        id: s.tempId,
      }));
    return [...finished, ...inProgress];
  });

  readonly hasArtifacts = computed(() => this.files().length > 0);

  readonly activeFile = computed(
    () => this.files().find((f) => f.filename === this.activeFilename()) ?? null,
  );

  constructor() {
    const socket = this.socketService.connect();
    this.destroyRef.onDestroy(() => this.cancelPendingSaves());

    socket.on(
      'artifact:stream:start',
      (payload: {
        tempId: string;
        sessionId: string;
        messageId: string;
        filename: string;
        language: string;
      }) => {
        if (payload.sessionId !== this.currentSessionId()) return;
        this.streaming.update((map) => {
          const next = new Map(map);
          next.set(payload.tempId, { ...payload, content: '' });
          return next;
        });
        this.openTabs.update((tabs) =>
          tabs.includes(payload.filename) ? tabs : [...tabs, payload.filename],
        );
        this.activeFilename.set(payload.filename);
      },
    );

    socket.on('artifact:stream:chunk', (payload: { tempId: string; delta: string }) => {
      this.streaming.update((map) => {
        const existing = map.get(payload.tempId);
        if (!existing) return map;
        const next = new Map(map);
        next.set(payload.tempId, { ...existing, content: existing.content + payload.delta });
        return next;
      });
    });

    socket.on(
      'artifact:stream:end',
      (payload: { tempId: string; realArtifactId: string; artifact?: CodeArtifactDto }) => {
        const streamingEntry = this.streaming().get(payload.tempId);
        if (streamingEntry && streamingEntry.sessionId === this.currentSessionId()) {
          this.artifacts.update((map) => {
            const next = new Map(map);
            next.set(
              streamingEntry.filename,
              payload.artifact ?? {
                id: payload.realArtifactId,
                messageId: streamingEntry.messageId,
                sessionId: streamingEntry.sessionId,
                filename: streamingEntry.filename,
                language: streamingEntry.language,
                content: streamingEntry.content,
                revision: 0,
                parentArtifactId: null,
                origin: 'ai',
                createdAt: new Date().toISOString(),
              },
            );
            return next;
          });
        }
        this.streaming.update((map) => {
          const next = new Map(map);
          next.delete(payload.tempId);
          return next;
        });
      },
    );

    socket.on('artifact:created', (payload: { artifact: CodeArtifactDto }) => {
      if (payload.artifact.sessionId !== this.currentSessionId()) return;
      this.artifacts.update((map) => {
        const next = new Map(map);
        next.set(payload.artifact.filename, payload.artifact);
        return next;
      });
    });
  }

  async loadSession(sessionId: string): Promise<void> {
    const generation = ++this.loadGeneration;
    this.cancelPendingSaves();
    this.currentSessionId.set(sessionId);
    this.artifacts.set(new Map());
    this.streaming.set(new Map());
    this.openTabs.set([]);
    this.activeFilename.set(null);

    const list = await firstValueFrom(
      this.http.get<CodeArtifactDto[]>(`/api/chat/sessions/${sessionId}/artifacts`),
    );
    if (generation !== this.loadGeneration || this.currentSessionId() !== sessionId) return;
    const map = new Map(list.map((a) => [a.filename, a] as const));
    this.artifacts.set(map);
    if (list.length > 0) {
      this.openTabs.set(list.map((a) => a.filename));
      this.activeFilename.set(list[0].filename);
    }
  }

  selectTab(filename: string): void {
    this.activeFilename.set(filename);
  }

  closeTab(filename: string): void {
    this.openTabs.update((tabs) => tabs.filter((t) => t !== filename));
    if (this.activeFilename() === filename) {
      const remaining = this.openTabs();
      this.activeFilename.set(remaining.length > 0 ? remaining[remaining.length - 1] : null);
    }
  }

  editContent(filename: string, content: string): void {
    const artifact = this.artifacts().get(filename);
    if (!artifact) return;

    this.artifacts.update((map) => {
      const next = new Map(map);
      next.set(filename, { ...artifact, content });
      return next;
    });
    this.scheduleSave(filename, artifact.id, content);
  }

  saveContent(filename: string): void {
    const pending = this.pendingSaves.get(filename);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSaves.delete(filename);
    this.emitSave(filename, pending.artifactId, pending.content);
  }

  private scheduleSave(filename: string, artifactId: string, content: string): void {
    const existing = this.pendingSaves.get(filename);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingSaves.delete(filename);
      this.emitSave(filename, artifactId, content);
    }, this.saveDebounceMs);
    this.pendingSaves.set(filename, { artifactId, content, timer });
  }

  private emitSave(filename: string, artifactId: string, content: string): void {
    const artifact = this.artifacts().get(filename);
    if (!artifact || artifact.id !== artifactId) return;
    this.socketService.instance.emit('artifact:edit', { artifactId, content });
  }

  private cancelPendingSaves(): void {
    for (const pending of this.pendingSaves.values()) clearTimeout(pending.timer);
    this.pendingSaves.clear();
  }
}
