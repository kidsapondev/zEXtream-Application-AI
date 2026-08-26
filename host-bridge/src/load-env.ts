import path from 'path';
import { config as loadDotenv } from 'dotenv';

/**
 * Loads `host-bridge/.env` into `process.env`, and does nothing else.
 *
 * It exists as its own module purely for *ordering*. `config.ts` reads `process.env` at
 * module-evaluation time, and TypeScript compiles this package to CommonJS, where every
 * `require` produced by an `import` statement runs before any statement in the importing
 * module's body. A `loadDotenv(...)` call written after the imports — however early it looks
 * in the source — therefore runs *after* `config.ts` has already captured an empty
 * environment. Importing this module first is what makes the load happen before anything
 * reads a variable.
 *
 * The failure that motivated this was invisible rather than loud: launched by an IDE or a
 * CLI that passed the variables itself, the server worked, because `process.env` was already
 * populated. Launched any other way it reported "workspace not configured" for a workspace
 * that was configured perfectly well in the file it claimed to read.
 *
 * Explicit path rather than dotenv's default `process.cwd()/.env`: the launcher chooses this
 * process's working directory (usually the folder the user has open, not this package), so a
 * cwd-relative lookup would find the wrong file or none at all. `__dirname` is
 * `host-bridge/dist` at runtime, so `..` is the package root.
 *
 * `quiet: true` is load-bearing, not tidiness: dotenv v17 prints an "injected env (N) from
 * .env" banner to **console.log**, and for the MCP server every byte on stdout is parsed as
 * a JSON-RPC message — that banner alone breaks the session before the first request.
 *
 * dotenv does not override variables already present in the environment, so a launcher that
 * sets them in its own config still wins.
 */
loadDotenv({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
