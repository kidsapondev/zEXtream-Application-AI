/**
 * Extension -> visual kind -> Monaco language, in one table.
 *
 * These three facts are kept together because they are always needed together and they
 * disagree in ways that would be invisible if they lived apart: `.mjs` and `.cjs` want the
 * *javascript* badge but Monaco's language id is still `javascript`, `.scss` and `.css`
 * share a badge colour but not a language, and `.txt` has no badge at all yet must still
 * resolve to `plaintext` or Monaco throws. Splitting the table would let one half drift.
 */

export type FileKind =
  'php' | 'js' | 'ts' | 'py' | 'css' | 'html' | 'json' | 'md' | 'img' | 'default';

interface KindDefinition {
  kind: FileKind;
  /** The two-or-three characters printed inside the coloured badge. */
  label: string;
  /** Monaco's language id. */
  language: string;
}

/**
 * Keyed by extension without the dot, lower-cased. Deliberately not exhaustive: an unknown
 * extension is a perfectly good outcome (grey badge, plaintext highlighting) and a workspace
 * of arbitrary host files will always contain more extensions than any table can name.
 */
const BY_EXTENSION: Record<string, KindDefinition> = {
  php: { kind: 'php', label: 'php', language: 'php' },

  js: { kind: 'js', label: 'js', language: 'javascript' },
  mjs: { kind: 'js', label: 'js', language: 'javascript' },
  cjs: { kind: 'js', label: 'js', language: 'javascript' },
  jsx: { kind: 'js', label: 'jsx', language: 'javascript' },

  ts: { kind: 'ts', label: 'ts', language: 'typescript' },
  mts: { kind: 'ts', label: 'ts', language: 'typescript' },
  tsx: { kind: 'ts', label: 'tsx', language: 'typescript' },

  py: { kind: 'py', label: 'py', language: 'python' },
  pyi: { kind: 'py', label: 'py', language: 'python' },

  css: { kind: 'css', label: 'css', language: 'css' },
  scss: { kind: 'css', label: 'sc', language: 'scss' },
  less: { kind: 'css', label: 'le', language: 'less' },

  html: { kind: 'html', label: 'ht', language: 'html' },
  htm: { kind: 'html', label: 'ht', language: 'html' },
  vue: { kind: 'html', label: 'vue', language: 'html' },
  svg: { kind: 'html', label: 'svg', language: 'xml' },
  xml: { kind: 'html', label: 'xml', language: 'xml' },

  json: { kind: 'json', label: '{}', language: 'json' },
  jsonc: { kind: 'json', label: '{}', language: 'json' },

  md: { kind: 'md', label: 'md', language: 'markdown' },
  mdx: { kind: 'md', label: 'md', language: 'markdown' },
  txt: { kind: 'md', label: 'txt', language: 'plaintext' },

  png: { kind: 'img', label: 'img', language: 'plaintext' },
  jpg: { kind: 'img', label: 'img', language: 'plaintext' },
  jpeg: { kind: 'img', label: 'img', language: 'plaintext' },
  gif: { kind: 'img', label: 'img', language: 'plaintext' },
  webp: { kind: 'img', label: 'img', language: 'plaintext' },
  ico: { kind: 'img', label: 'img', language: 'plaintext' },

  yml: { kind: 'default', label: 'yml', language: 'yaml' },
  yaml: { kind: 'default', label: 'yml', language: 'yaml' },
  sh: { kind: 'default', label: 'sh', language: 'shell' },
  bash: { kind: 'default', label: 'sh', language: 'shell' },
  ps1: { kind: 'default', label: 'ps', language: 'powershell' },
  sql: { kind: 'default', label: 'sql', language: 'sql' },
  go: { kind: 'default', label: 'go', language: 'go' },
  rs: { kind: 'default', label: 'rs', language: 'rust' },
  java: { kind: 'default', label: 'jv', language: 'java' },
  rb: { kind: 'default', label: 'rb', language: 'ruby' },
  c: { kind: 'default', label: 'c', language: 'c' },
  h: { kind: 'default', label: 'h', language: 'c' },
  cpp: { kind: 'default', label: 'c+', language: 'cpp' },
  cs: { kind: 'default', label: 'cs', language: 'csharp' },
};

/**
 * Dotfiles that carry a recognisable identity in their *whole* name rather than an
 * extension. Checked before the extension lookup so `.env.local` doesn't get read as an
 * extension of `local`.
 */
const BY_FILENAME: Record<string, KindDefinition> = {
  dockerfile: { kind: 'default', label: 'dk', language: 'dockerfile' },
  makefile: { kind: 'default', label: 'mk', language: 'plaintext' },
  '.gitignore': { kind: 'default', label: 'git', language: 'plaintext' },
  '.env': { kind: 'default', label: 'env', language: 'ini' },
};

const FALLBACK: KindDefinition = {
  kind: 'default',
  label: '•',
  language: 'plaintext',
};

function definitionFor(fileName: string): KindDefinition {
  const name = (fileName.split('/').pop() ?? fileName).toLowerCase();

  const byName = BY_FILENAME[name];
  if (byName) return byName;
  // `.env.production` and friends: fall back to the base dotfile identity.
  if (name.startsWith('.env.')) return BY_FILENAME['.env'] ?? FALLBACK;

  const dot = name.lastIndexOf('.');
  // `dot <= 0` covers both "no extension" and a leading-dot file with nothing after it, so
  // `.gitignore` never resolves to an extension of "gitignore".
  if (dot <= 0) return FALLBACK;

  return BY_EXTENSION[name.slice(dot + 1)] ?? FALLBACK;
}

export function fileKindFor(fileName: string): FileKind {
  return definitionFor(fileName).kind;
}

export function fileIconLabelFor(fileName: string): string {
  return definitionFor(fileName).label;
}

export function monacoLanguageFor(fileName: string): string {
  return definitionFor(fileName).language;
}
