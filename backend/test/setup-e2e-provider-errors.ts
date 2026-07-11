/**
 * Extra `setupFiles` entry, applied only to the "e2e-provider-errors" Jest
 * project (see jest-e2e.json), on top of the normal setup-e2e.ts defaults.
 *
 * Same reasoning as setup-e2e-stop.ts: `@nestjs/config`'s
 * `ConfigModule.forRoot({ validate })` freezes `process.env` the moment
 * app.module.ts is first imported into a Jest file's module registry, so
 * OLLAMA_BASE_URL has to be set here, before that import happens, rather
 * than inside the spec file's own `beforeAll`. A dedicated fixed port (distinct
 * from setup-e2e-stop.ts's CHAT_STOP_BLACKHOLE_PORT) is used for the same
 * reason documented there: setupFiles only run synchronous top-level code,
 * so the port can't be dynamically assigned here.
 */
export const PROVIDER_ERRORS_MOCK_PORT = 58241;

process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${PROVIDER_ERRORS_MOCK_PORT}`;
