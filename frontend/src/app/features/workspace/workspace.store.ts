import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { monacoLanguageFor } from './file-icon/file-kinds';
import {
  WorkspaceApiError,
  WorkspaceApiService,
  type WorkspaceEntry,
  type WorkspaceStatus,
} from './workspace-api.service';

/** The five preset prompts on the toolbar. */
export type WorkspaceActionName = 'debug' | 'optimize' | 'translate' | 'documentation' | 'generate';

/**
 * What the toolbar hands to whoever is listening.
 *
 * It carries the file's *content* and not just its path deliberately: the listener is an AI
 * panel that is about to compose a prompt, and if it had to re-read the file it would (a)
 * spend another round trip through a host subprocess and (b) get the version on disk rather
 * than the unsaved buffer the user is actually looking at and asking about.
 */
export interface WorkspaceActionRequest {
  action: WorkspaceActionName;
  /** Human label as it reads on the button, so a panel can echo it without a second table. */
  label: string;
  path: string | null;
  language: string;
  content: string | null;
}

export interface WorkspaceTab {
  path: string;
  name: string;
  language: string;
  /** The buffer as it is right now, including unsaved edits. */
  content: string;
  /** The buffer as of the last successful load or save — the baseline `dirty` compares to. */
  savedContent: string;
  bytes: number;
  truncated: boolean;
  /**
   * True for a truncated file. The host cut it off at `maxFileBytes`, so the buffer is only
   * a prefix, and writing it back would delete everything past the cut. Read-only is the
   * only safe answer short of a partial-write API that does not exist.
   */
  readOnly: boolean;
  saving: boolean;
  error: string | null;
}

export interface DirectoryNode {
  path: string;
  state: 'loading' | 'loaded' | 'error';
  entries: WorkspaceEntry[];
  error: string | null;
}

/** One rendered line of the tree: the flattened, depth-tagged view the explorer draws. */
export interface ExplorerRow {
  path: string;
  name: string;
  type: 'file' | 'dir';
  depth: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
}

const ACTION_LABELS: Record<WorkspaceActionName, string> = {
  debug: 'Debug',
  optimize: 'Optimize',
  translate: 'Translate',
  documentation: 'Documentation',
  generate: 'Generate code',
};

/**
 * Shown when `/workspace/status` reports `available: false`.
 *
 * The status route is the one route that answers even when unconfigured (so the UI can find
 * out *why* nothing works), and the price of that is that it returns a flag rather than the
 * explanatory 503 body every other route returns. This string is the same explanation, kept
 * in step with `WorkspaceController.assertEnabled()`. A real 503 from any other route wins
 * over it, because that message comes from the server and cannot go stale.
 */
const UNCONFIGURED_MESSAGE =
  'The host workspace is not configured. Set WORKSPACE_BRIDGE_URL in the backend ' +
  'environment and BRIDGE_WORKSPACE_ROOT in host-bridge/.env.';

export function isTabDirty(tab: WorkspaceTab): boolean {
  return tab.content !== tab.savedContent;
}

/** `''` is the workspace root, so a plain `${a}/${b}` would produce a leading slash. */
export function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Directories before files, then case-insensitive by name.
 *
 * Sorted here rather than trusted from the host because the bridge returns whatever
 * `readdir` gave it, which is filesystem order — stable on ext4, arbitrary elsewhere — and a
 * tree whose rows move between two expansions of the same folder is unusable.
 */
function sortEntries(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function messageOf(error: unknown): string {
  if (error instanceof WorkspaceApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The workspace request failed.';
}

/**
 * All of the web IDE's state: the lazily-materialised file tree, the open editor tabs, and
 * the workspace's availability.
 *
 * Root-provided, not component-provided, and that is the point. The page component is only
 * one of three things looking at this state — a bottom dock wants the active file's path to
 * seed a terminal `cwd`, an AI panel wants the unsaved buffer to put in a prompt and wants
 * to write a patch back into it — and a store scoped to the page would force those siblings
 * to reach through `@Input`/`@Output` chains that break the moment the layout changes. The
 * cost is that state survives navigating away from the page, which is the behaviour anyone
 * would want from open editor tabs anyway.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly api = inject(WorkspaceApiService);

  readonly status = signal<WorkspaceStatus | null>(null);
  readonly isInitializing = signal(false);

  /**
   * Non-null only for the "operator never set this up" case. Everything else is a per-row or
   * per-tab error, because everything else leaves the rest of the IDE usable.
   */
  readonly unavailableMessage = signal<string | null>(null);

  private readonly directories = signal<ReadonlyMap<string, DirectoryNode>>(new Map());
  private readonly expandedPaths = signal<ReadonlySet<string>>(new Set());

  readonly tabs = signal<readonly WorkspaceTab[]>([]);
  readonly activePath = signal<string | null>(null);
  /** The explorer row drawn as a filled rounded rectangle — a folder or a file. */
  readonly selectedPath = signal<string | null>(null);

  private readonly actionSubject = new Subject<WorkspaceActionRequest>();
  /** Push-shaped for a panel that wants to react; `lastAction` is the pull-shaped twin. */
  readonly actions: Observable<WorkspaceActionRequest> = this.actionSubject.asObservable();
  readonly lastAction = signal<WorkspaceActionRequest | null>(null);

  readonly isAvailable = computed(() => this.status()?.available === true);

  readonly activeTab = computed(() => {
    const path = this.activePath();
    return path === null ? null : (this.tabs().find((tab) => tab.path === path) ?? null);
  });

  /** Paths with unsaved edits — the small dot on the right of an explorer row. */
  readonly modifiedPaths = computed(
    () =>
      new Set(
        this.tabs()
          .filter(isTabDirty)
          .map((tab) => tab.path),
      ),
  );

  readonly breadcrumb = computed(() => {
    const path = this.activePath();
    if (!path) return [] as { name: string; path: string; isFile: boolean }[];
    const segments = path.split('/');
    return segments.map((name, index) => ({
      name,
      path: segments.slice(0, index + 1).join('/'),
      isFile: index === segments.length - 1,
    }));
  });

  /**
   * The tree, flattened depth-first into the rows that are currently visible.
   *
   * Flat rather than nested because only expanded folders contribute rows at all, which is
   * what makes lazy loading work: a folder that has never been opened has no `DirectoryNode`
   * and therefore no children to walk, so nothing here can accidentally demand data that was
   * never fetched.
   */
  readonly rows = computed<ExplorerRow[]>(() => {
    const directories = this.directories();
    const expanded = this.expandedPaths();
    const out: ExplorerRow[] = [];

    const walk = (directoryPath: string, depth: number): void => {
      const node = directories.get(directoryPath);
      if (!node) return;

      for (const entry of node.entries) {
        const path = joinPath(directoryPath, entry.name);
        const isOpen = entry.type === 'dir' && expanded.has(path);
        const child = isOpen ? directories.get(path) : undefined;

        out.push({
          path,
          name: entry.name,
          type: entry.type,
          depth,
          expanded: isOpen,
          loading: child?.state === 'loading',
          error: child?.state === 'error' ? child.error : null,
        });

        if (isOpen) walk(path, depth + 1);
      }
    };

    walk('', 0);
    return out;
  });

  readonly rootNode = computed(() => this.directories().get('') ?? null);

  private initialized = false;
  /** Paths with a `read` in flight, so a double-click cannot open two tabs for one file. */
  private readonly opening = new Set<string>();

  /**
   * Idempotent: the page calls this on every construction, but the store outlives the page
   * (it is root-provided) and a second navigation must not wipe the open tabs and re-walk
   * the tree from scratch.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.reload();
  }

  /** Re-checks availability and re-reads the root. Also the retry button's handler. */
  async reload(): Promise<void> {
    this.isInitializing.set(true);
    this.unavailableMessage.set(null);
    try {
      const status = await this.api.status();
      this.status.set(status);
      if (!status.available) {
        this.unavailableMessage.set(UNCONFIGURED_MESSAGE);
        return;
      }
      await this.loadDirectory('');
    } catch (error) {
      // `status` itself failing means the API is unreachable or the session expired — either
      // way there is no tree to draw, so it gets the same full-panel treatment as a 503.
      this.status.set(null);
      this.unavailableMessage.set(messageOf(error));
    } finally {
      this.isInitializing.set(false);
    }
  }

  /**
   * Expands or collapses a folder, fetching its contents the first time it is opened.
   *
   * Lazy on purpose: every listing is a round trip through a subprocess on the host, so
   * walking the tree eagerly would cost one process spawn per directory in the workspace
   * before the user has clicked anything. Collapsing keeps the fetched entries cached, so
   * re-opening a folder is instant; `refreshDirectory` is the way to deliberately re-fetch.
   */
  async toggleDirectory(path: string): Promise<void> {
    this.selectedPath.set(path);

    const expanded = new Set(this.expandedPaths());
    if (expanded.has(path)) {
      expanded.delete(path);
      this.expandedPaths.set(expanded);
      return;
    }

    expanded.add(path);
    this.expandedPaths.set(expanded);

    const node = this.directories().get(path);
    if (node && node.state !== 'error') return;
    await this.loadDirectory(path);
  }

  async refreshDirectory(path: string): Promise<void> {
    await this.loadDirectory(path);
  }

  collapseAll(): void {
    this.expandedPaths.set(new Set());
  }

  /**
   * Opens a file, or focuses it if it is already open.
   *
   * Focus-don't-duplicate matters beyond tidiness: two tabs over one path would each hold
   * their own buffer and their own `savedContent`, so saving one would silently make the
   * other's "unsaved" badge a lie about a file that no longer says what it shows.
   */
  async openFile(path: string): Promise<void> {
    this.selectedPath.set(path);

    if (this.tabs().some((tab) => tab.path === path)) {
      this.activePath.set(path);
      return;
    }
    if (this.opening.has(path)) return;

    this.opening.add(path);
    try {
      const result = await this.api.read(path);
      // Re-check: another `openFile` for this path may have resolved while this one was in
      // flight — the guard above only covers the synchronous case.
      if (this.tabs().some((tab) => tab.path === path)) {
        this.activePath.set(path);
        return;
      }

      const tab: WorkspaceTab = {
        path,
        name: baseName(path),
        language: monacoLanguageFor(path),
        content: result.content,
        savedContent: result.content,
        bytes: result.bytes,
        truncated: result.truncated,
        readOnly: result.truncated,
        saving: false,
        error: null,
      };
      this.tabs.update((tabs) => [...tabs, tab]);
      this.activePath.set(path);
    } catch (error) {
      this.noteFailure(error);
    } finally {
      this.opening.delete(path);
    }
  }

  activateTab(path: string): void {
    if (!this.tabs().some((tab) => tab.path === path)) return;
    this.activePath.set(path);
    this.selectedPath.set(path);
  }

  closeTab(path: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return;

    const remaining = tabs.filter((tab) => tab.path !== path);
    this.tabs.set(remaining);
    if (this.activePath() !== path) return;

    // Focus the tab to the left, which is where the eye already is, falling back to the new
    // last tab when the leftmost was the one closed.
    const next = remaining[index - 1] ?? remaining[index] ?? null;
    this.activePath.set(next ? next.path : null);
  }

  /** Records an edit from the editor. Also the entry point for an AI panel applying a patch. */
  edit(path: string, content: string): void {
    this.tabs.update((tabs) =>
      tabs.map((tab) => (tab.path === path && !tab.readOnly ? { ...tab, content } : tab)),
    );
  }

  /** Overrides the syntax highlighting for one tab — the toolbar's language picker. */
  setLanguage(path: string, language: string): void {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.path === path ? { ...tab, language } : tab)));
  }

  async save(path: string | null = this.activePath()): Promise<void> {
    if (path === null) return;
    const tab = this.tabs().find((candidate) => candidate.path === path);
    if (!tab || tab.readOnly || tab.saving || !isTabDirty(tab)) return;

    // Snapshot before the round trip: the user keeps typing during it, and the new baseline
    // must be what was actually written, not whatever the buffer holds when the reply lands.
    const written = tab.content;
    this.patchTab(path, { saving: true, error: null });

    try {
      const result = await this.api.write(path, written);
      this.patchTab(path, { savedContent: written, bytes: result.bytes, saving: false });
    } catch (error) {
      this.patchTab(path, { saving: false, error: messageOf(error) });
      this.noteFailure(error);
    }
  }

  /**
   * Creates an empty file and opens it. A bare name lands in whichever directory is
   * currently selected, which is what a "new file" button in a tree is expected to mean; a
   * name containing a slash is taken as a full workspace-relative path instead.
   */
  async createFile(name: string): Promise<void> {
    const trimmed = name.trim().replace(/^\/+/, '');
    if (!trimmed) return;

    const directory = this.selectedDirectory();
    const path = trimmed.includes('/') ? trimmed : joinPath(directory, trimmed);

    try {
      await this.api.write(path, '');
      const parent = parentPath(path);
      // Expand the parent first: refreshing a directory nobody has opened would fetch rows
      // that the flattened tree then refuses to draw, so the new file would appear nowhere.
      this.expandedPaths.update((paths) => new Set(paths).add(parent));
      await this.loadDirectory(parent);
      await this.openFile(path);
    } catch (error) {
      this.noteFailure(error);
    }
  }

  /**
   * Fires one of the toolbar's preset prompts.
   *
   * This store deliberately does not know what a "Debug" prompt says or which model runs it.
   * The chat WebSocket already owns the model -> tool -> model loop against this same
   * workspace; a second path into the model from here would be a second loop to keep in step
   * with the first. So this only announces *what the user asked for, about which file*.
   */
  runAction(action: WorkspaceActionName): void {
    const tab = this.activeTab();
    const request: WorkspaceActionRequest = {
      action,
      label: ACTION_LABELS[action],
      path: tab?.path ?? null,
      language: tab?.language ?? 'plaintext',
      content: tab?.content ?? null,
    };
    this.lastAction.set(request);
    this.actionSubject.next(request);
  }

  /** The directory a new file should land in, given whatever row is selected. */
  private selectedDirectory(): string {
    const selected = this.selectedPath();
    if (selected === null) return '';
    const row = this.rows().find((candidate) => candidate.path === selected);
    if (!row) return '';
    return row.type === 'dir' ? selected : parentPath(selected);
  }

  private async loadDirectory(path: string): Promise<void> {
    this.putDirectory({ path, state: 'loading', entries: this.entriesOf(path), error: null });
    try {
      const result = await this.api.list(path);
      this.putDirectory({
        path,
        state: 'loaded',
        entries: sortEntries(result.entries),
        error: null,
      });
    } catch (error) {
      this.putDirectory({
        path,
        state: 'error',
        entries: this.entriesOf(path),
        error: messageOf(error),
      });
      this.noteFailure(error);
    }
  }

  /** Keeps the previous rows visible while a refresh is in flight, so the tree doesn't blink. */
  private entriesOf(path: string): WorkspaceEntry[] {
    return this.directories().get(path)?.entries ?? [];
  }

  private putDirectory(node: DirectoryNode): void {
    this.directories.update((map) => new Map(map).set(node.path, node));
  }

  private patchTab(path: string, patch: Partial<WorkspaceTab>): void {
    this.tabs.update((tabs) => tabs.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
  }

  /**
   * A 503 from *any* route retroactively means the workspace was switched off (or was never
   * on and the user arrived from a stale tab), so it promotes to the full-panel message —
   * with the server's own wording, which names the settings to change.
   */
  private noteFailure(error: unknown): void {
    if (error instanceof WorkspaceApiError && error.isUnavailable) {
      this.unavailableMessage.set(error.message);
      this.status.update((status) => (status ? { ...status, available: false } : status));
    }
  }
}
