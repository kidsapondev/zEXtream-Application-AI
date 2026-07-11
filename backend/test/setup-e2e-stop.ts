/**
 * Extra `setupFiles` entry, applied only to the "e2e-stop" Jest project (see
 * jest-e2e.json), on top of the normal setup-e2e.ts defaults.
 *
 * Why this can't just be a `process.env.OLLAMA_BASE_URL = ...` line inside
 * chat-stop.e2e-spec.ts's own `beforeAll`: `@nestjs/config`'s
 * `ConfigModule.forRoot({ validate })` (see app.module.ts) reads and
 * validates `process.env` *synchronously, once, at the moment `forRoot()` is
 * called* — which happens when `app.module.ts` is first imported into a
 * given Jest test file's module registry, not per `Test.createTestingModule
 * ().compile()` call. A single test file that builds more than one Nest app
 * (as this project's split from the main "e2e" project exists to avoid)
 * would have every app share the *first* app's frozen config, so mutating
 * `process.env.OLLAMA_BASE_URL` later in that same file has no effect on
 * already- or later-compiled apps in it. Setting it here, in a `setupFiles`
 * entry that runs before the spec file's own imports (and therefore before
 * `app.module.ts` is ever evaluated in this project's isolated module
 * registry), sidesteps that entirely — this project's one app instance is
 * the *first and only* app.module.ts import in its registry, so it picks
 * this value up correctly.
 *
 * A fixed (not dynamically-assigned) port is used deliberately: setupFiles
 * only run synchronous top-level code (Jest does not await an async default
 * export — verified empirically before choosing this design), so the actual
 * port can't be determined here via `server.listen(0, cb)`. chat-stop.e2e-
 * spec.ts's own `beforeAll` starts the real black-hole TCP listener on this
 * exact port.
 */
export const CHAT_STOP_BLACKHOLE_PORT = 58239;

process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${CHAT_STOP_BLACKHOLE_PORT}`;
