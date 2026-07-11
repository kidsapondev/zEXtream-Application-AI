import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Secrets that may be supplied as a file instead of a plain value, via a
// `<KEY>_FILE` env var pointing at the file's path. This is the common
// convention behind Docker Compose secrets, Kubernetes Secrets mounted as
// files, and most secret-manager integrations (a Vault agent template, an
// AWS Secrets Manager sidecar, etc. all boil down to "render the secret to a
// file, then point an env var at that path") — supporting it here means this
// app works with any of them without depending on a specific vendor's SDK.
const SECRET_FILE_KEYS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'API_KEY_ENCRYPTION_KEY',
] as const;

/** Resolves any `<KEY>_FILE` variables into the corresponding plain key before validation. */
function resolveSecretFiles(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = { ...config };
  for (const key of SECRET_FILE_KEYS) {
    const filePath = config[`${key}_FILE`];
    if (typeof filePath !== 'string' || filePath.length === 0) continue;
    resolved[key] = readFileSync(filePath, 'utf8').trim();
  }
  return resolved;
}

const durationString = z
  .string()
  .regex(/^\d+(s|m|h|d)$/, 'must look like "15m", "7d", "1h", etc.');

function isAes256Key(value: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').length === 32;
}

// A valid CORS origin entry is a bare "scheme://host[:port]" with no path/query/hash —
// re-serializing it via URL must round-trip exactly, otherwise something like
// "http://a.com/evil" (which URL happily parses) would slip through as an "origin".
function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: durationString.default('15m'),
  JWT_REFRESH_EXPIRES_IN: durationString.default('7d'),
  API_KEY_ENCRYPTION_KEY: z
    .string()
    .refine(
      isAes256Key,
      'must be a 32-byte Base64/Base64url value or 64-character hex value',
    ),
  OLLAMA_BASE_URL: z.string().url(),
  // Comma-separated allowlist of exact origins allowed to make credentialed cross-origin
  // requests (e.g. "http://localhost:4200,https://staging.example.com"). Kept
  // backward-compatible with the historical single-origin value. Left unset in
  // production, where nginx proxies the frontend and backend under one origin and no
  // cross-origin requests are expected — see main.ts for how an empty allowlist is
  // handled (CORS is disabled outright rather than defaulting to "allow everything").
  CORS_ORIGIN: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
        : [],
    )
    .refine(
      (origins) => origins.every(isBareOrigin),
      'each CORS_ORIGIN entry must be a bare origin like "https://example.com" (no path/query)',
    ),
  // Number of trusted reverse-proxy hops in front of the app (Express `trust proxy`
  // semantics). 0 = trust nothing, use the raw socket address — the safe default for
  // bare/dev runs where a client could otherwise spoof X-Forwarded-For themselves.
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  // Pino log level for structured logging (see main.ts / logger.module.ts).
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  // Optional error reporting (see backend/src/common/sentry.ts). Unset means disabled —
  // no Sentry SDK network calls happen at all. The DSN is not a secret (Sentry's browser
  // DSNs are meant to be public and are served to the frontend via GET /api/config), so
  // it doesn't need the <KEY>_FILE treatment applied to the actual secrets above.
  //
  // Both use z.preprocess() to treat an empty string as absent, not as an invalid/blank
  // value — docker-compose.yml passes these through as `${SENTRY_DSN:-}`, which resolves
  // to an empty string (not truly unset) whenever the .env var itself is unset, so "" has
  // to mean the same thing "undefined" does here, or a plain deploy with no Sentry
  // configured would fail validation on SENTRY_DSN (empty string isn't a valid URL) and
  // silently misbehave on SENTRY_ENVIRONMENT (an empty string is falsy-but-not-nullish, so
  // the `??` fallback to NODE_ENV in sentry.ts/public-config.controller.ts wouldn't trigger).
  SENTRY_DSN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().optional(),
  ),
  SENTRY_ENVIRONMENT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(resolveSecretFiles(config));
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return result.data;
}
