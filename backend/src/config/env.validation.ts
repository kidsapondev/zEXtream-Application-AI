import { z } from 'zod';

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
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return result.data;
}
