import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Params } from 'nestjs-pino';

/**
 * Shared pino-http configuration used by LoggerModule.forRootAsync in app.module.ts.
 *
 * - genReqId: reuses an incoming X-Request-Id header when present (so a request that
 *   already has a correlation id from an upstream proxy/load-balancer keeps it end to
 *   end), otherwise mints a new one, and always echoes it back as a response header so
 *   the client/caller can correlate logs with the request that produced them.
 * - redact: auth headers/cookies carry JWTs/refresh tokens, and a handful of request
 *   bodies carry passwords or provider API keys in plaintext on the wire (before this
 *   process ever encrypts/hashes them) — none of that may ever reach the log output.
 *   `remove: true` drops the field entirely rather than printing "[Redacted]", so a
 *   payload shape change elsewhere can't accidentally leak a new secret field by
 *   forgetting to add it here (message/AI-response bodies are never logged at all,
 *   since pino-http only serializes req/res metadata, not arbitrary handler payloads).
 */
export function buildPinoHttpOptions(
  logLevel: string,
  isProduction: boolean,
): Params['pinoHttp'] {
  return {
    level: logLevel,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const header = req.headers['x-request-id'];
      const incoming = Array.isArray(header) ? header[0] : header;
      const id = incoming && incoming.trim() ? incoming.trim() : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.apiKey',
        'req.body.accessToken',
        'req.body.refreshToken',
      ],
      remove: true,
    },
    autoLogging: true,
    // Trim the request/response objects pino-http logs by default down to the fields
    // actually useful for correlation — the defaults already exclude bodies, but this
    // keeps log lines small and avoids incidentally logging query strings that might
    // carry tokens.
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
    },
    ...(isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, singleLine: true },
          },
        }),
  };
}
