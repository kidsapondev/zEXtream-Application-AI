import { Injectable, computed, inject, signal } from '@angular/core';
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

  /** Latest revision of each file, keyed by filename. */
  private readonly artifacts = signal<Map<string, CodeArtifactDto>>(new Map());
  /** Artifacts currently being written by the AI, keyed by tempId. */
  private readonly streaming = signal<Map<string, StreamingArtifact>>(new Map());

  readonly openTabs = signal<string[]>([]);
  readonly activeFilename = signal<string | null>(null);

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
      .map((s) => ({ filename: s.filename, language: s.language, content: s.content, streaming: true, id: s.tempId }));
    return [...finished, ...inProgress];
  });

  readonly hasArtifacts = computed(() => this.files().length > 0);

  readonly activeFile = computed(() => this.files().find((f) => f.filename === this.activeFilename()) ?? null);

  constructor() {
    const socket = this.socketService.connect();

    socket.on(
      'artifact:stream:start',
      (payload: { tempId: string; sessionId: string; messageId: string; filename: string; language: string }) => {
        this.streaming.update((map) => {
          const next = new Map(map);
          next.set(payload.tempId, { ...payload, content: '' });
          return next;
        });
        this.openTabs.update((tabs) => (tabs.includes(payload.filename) ? tabs : [...tabs, payload.filename]));
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

    socket.on('artifact:stream:end', (payload: { tempId: string; realArtifactId: string }) => {
      const streamingEntry = this.streaming().get(payload.tempId);
      if (streamingEntry) {
        this.artifacts.update((map) => {
          const next = new Map(map);
          next.set(streamingEntry.filename, {
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
          });
          return next;
        });
      }
      this.streaming.update((map) => {
        const next = new Map(map);
        next.delete(payload.tempId);
        return next;
      });
    });

    socket.on('artifact:created', (payload: { artifact: CodeArtifactDto }) => {
      this.artifacts.update((map) => {
        const next = new Map(map);
        next.set(payload.artifact.filename, payload.artifact);
        return next;
      });
    });
  }

  async loadSession(sessionId: string): Promise<void> {
    this.artifacts.set(new Map());
    this.streaming.set(new Map());
    this.openTabs.set([]);
    this.activeFilename.set(null);

    const list = await firstValueFrom(
      this.http.get<CodeArtifactDto[]>(`/api/chat/sessions/${sessionId}/artifacts`),
    );
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
    this.socketService.instance.emit('artifact:edit', { artifactId: artifact.id, content });
  }
}
