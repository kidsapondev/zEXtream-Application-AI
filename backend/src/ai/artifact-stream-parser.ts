// Incrementally splits an assistant's raw token stream into prose and fenced-code
// segments as content arrives, so code can be mirrored into the editor panel live
// instead of waiting for the whole message to finish.
//
// Convention (communicated to models via system prompt): code blocks are fenced as
// ```lang:relative/path.ext — a normal markdown fence extended with a filename after
// a colon, since plain markdown fences don't carry a filename. A model that omits the
// filename still gets an auto-generated one.
//
// Known v1 limitation: a fence marker is only recognized at the start of a line, and
// code containing a literal ``` sequence inline isn't specially escaped — rare enough
// in practice to accept rather than build a full markdown-aware scanner for.

export type ParsedSegment =
  | { type: 'prose'; text: string }
  | { type: 'artifact-start'; language: string; filename: string }
  | { type: 'artifact-chunk'; text: string }
  | { type: 'artifact-end' };

const EXTENSION_BY_LANGUAGE: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  javascript: 'js',
  js: 'js',
  python: 'py',
  py: 'py',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'md',
  md: 'md',
  sql: 'sql',
  go: 'go',
  rust: 'rs',
  java: 'java',
  csharp: 'cs',
};

function findAtLineStart(buf: string, re: RegExp): RegExpExecArray | null {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buf))) {
    const atLineStart = match.index === 0 || buf[match.index - 1] === '\n';
    if (atLineStart) return match;
    if (match[0].length === 0) re.lastIndex++;
  }
  return null;
}

/** Longest suffix of `text` that is also a prefix of `marker` (how much to hold back). */
function suspiciousTailLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

const FENCE_OPEN_RE = /```([a-zA-Z0-9_+-]*)(?::(\S+))?\r?\n/g;
const FENCE_CLOSE_RE = /```\r?\n/g;

export class ArtifactStreamParser {
  private buffer = '';
  private inBlock = false;
  private snippetCounter = 0;
  private atMessageStart = true;

  push(delta: string): ParsedSegment[] {
    this.buffer += delta;
    const segments: ParsedSegment[] = [];

    for (;;) {
      if (!this.inBlock) {
        const match = findAtLineStart(this.buffer, FENCE_OPEN_RE);
        if (match?.index !== undefined) {
          const before = this.buffer.slice(0, match.index);
          if (before) segments.push({ type: 'prose', text: before });
          const language = match[1] || 'text';
          const filename = match[2] || this.autoFilename(language);
          segments.push({ type: 'artifact-start', language, filename });
          this.buffer = this.buffer.slice(match.index + match[0].length);
          this.inBlock = true;
          this.atMessageStart = false;
          continue;
        }

        const holdBack = Math.max(
          suspiciousTailLength(this.buffer, '\n```'),
          this.atMessageStart ? suspiciousTailLength(this.buffer, '```') : 0,
        );
        const safeLength = this.buffer.length - holdBack;
        if (safeLength > 0) {
          segments.push({ type: 'prose', text: this.buffer.slice(0, safeLength) });
          this.buffer = this.buffer.slice(safeLength);
          this.atMessageStart = false;
        }
        break;
      } else {
        const match = findAtLineStart(this.buffer, FENCE_CLOSE_RE);
        if (match?.index !== undefined) {
          const before = this.buffer.slice(0, match.index);
          if (before) segments.push({ type: 'artifact-chunk', text: before });
          segments.push({ type: 'artifact-end' });
          this.buffer = this.buffer.slice(match.index + match[0].length);
          this.inBlock = false;
          continue;
        }

        const holdBack = suspiciousTailLength(this.buffer, '\n```');
        const safeLength = this.buffer.length - holdBack;
        if (safeLength > 0) {
          segments.push({ type: 'artifact-chunk', text: this.buffer.slice(0, safeLength) });
          this.buffer = this.buffer.slice(safeLength);
        }
        break;
      }
    }

    return segments;
  }

  /** Call once at end-of-stream to flush anything still held back. */
  flush(): ParsedSegment[] {
    if (!this.buffer) return [];
    const segments: ParsedSegment[] = [];
    if (this.inBlock) {
      segments.push({ type: 'artifact-chunk', text: this.buffer });
      segments.push({ type: 'artifact-end' });
    } else {
      segments.push({ type: 'prose', text: this.buffer });
    }
    this.buffer = '';
    return segments;
  }

  private autoFilename(language: string): string {
    this.snippetCounter += 1;
    const ext = EXTENSION_BY_LANGUAGE[language.toLowerCase()] ?? 'txt';
    return `snippet-${this.snippetCounter}.${ext}`;
  }
}
