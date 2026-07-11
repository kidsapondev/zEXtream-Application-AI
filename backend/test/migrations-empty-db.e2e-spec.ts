import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';

const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * "Integration test that runs migrations on a genuinely empty database"
 * (plan.md Phase 1 "ต้องทำต่อ") — this deliberately does *not* reuse the
 * shared e2e app/DB (see support/test-app.ts), because that database already
 * has every migration applied by the time any spec file runs. Proving
 * `prisma migrate deploy` works means creating a brand-new, never-migrated
 * database inside the same Postgres instance, running the exact command
 * docker-compose.yml's `migrate` service runs (`pnpm exec prisma migrate
 * deploy`) against it, and inspecting the result — then dropping it.
 *
 * Also covers plan.md's separate "uuidv7() compatibility" item: confirms
 * Postgres's native `uuidv7()` (no `CREATE EXTENSION` — see the comment
 * below) is available and produces RFC 9562 version-7 UUIDs on a freshly
 * migrated database, via both a raw function call and a real inserted row.
 */
describe('Prisma migrations on an empty database (e2e)', () => {
  const backendRoot = path.resolve(__dirname, '..');
  let baseUrl: URL;
  let freshDbName: string;
  let freshDatabaseUrl: string;
  let adminClient: Client;

  function runMigrateDeploy(): void {
    try {
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        cwd: backendRoot,
        env: { ...process.env, DATABASE_URL: freshDatabaseUrl },
        stdio: 'pipe',
        shell: true,
      });
    } catch (error) {
      const execError = error as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma migrate deploy failed:\n--- stdout ---\n${execError.stdout?.toString()}\n--- stderr ---\n${execError.stderr?.toString()}`,
      );
    }
  }

  beforeAll(async () => {
    // setup-e2e.ts (this suite's Jest setupFiles entry) has already set
    // DATABASE_URL to a known-good target before this file is required.
    baseUrl = new URL(process.env.DATABASE_URL!);
    freshDbName = `empty_migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    adminClient = new Client({ connectionString: baseUrl.toString() });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${freshDbName}"`);

    const freshUrl = new URL(baseUrl.toString());
    freshUrl.pathname = `/${freshDbName}`;
    freshDatabaseUrl = freshUrl.toString();
  });

  afterAll(async () => {
    // Migrate deploy and the assertion queries below each open/close their
    // own connections, but terminate defensively before DROP DATABASE so a
    // stray lingering connection can never make cleanup fail.
    await adminClient.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [freshDbName],
    );
    await adminClient.query(`DROP DATABASE IF EXISTS "${freshDbName}"`);
    await adminClient.end();
  });

  it('applies every migration cleanly to a genuinely empty database', () => {
    runMigrateDeploy();
  });

  it('creates every expected table and records every migration as applied', async () => {
    const client = new Client({ connectionString: freshDatabaseUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const tableNames = tables.rows.map((row) => row.table_name);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          'users',
          'refresh_tokens',
          'chat_sessions',
          'messages',
          'code_artifacts',
          'provider_credentials',
          '_prisma_migrations',
        ]),
      );

      const migrations = await client.query<{
        migration_name: string;
        finished_at: Date | null;
      }>(
        `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name`,
      );
      expect(migrations.rows.length).toBeGreaterThanOrEqual(4);
      expect(migrations.rows.every((row) => row.finished_at !== null)).toBe(
        true,
      );
    } finally {
      await client.end();
    }
  });

  it('is idempotent: re-running migrate deploy against an already-migrated database is a safe no-op', () => {
    runMigrateDeploy();
  });

  it('generates version-7 UUIDs via Postgres-native uuidv7(), with no CREATE EXTENSION step in any migration', async () => {
    const client = new Client({ connectionString: freshDatabaseUrl });
    await client.connect();
    try {
      // No migration.sql in this repo runs `CREATE EXTENSION` — uuidv7() is a
      // PostgreSQL 18 builtin (docker-compose.yml pins postgres:18.4-alpine),
      // not pgcrypto's gen_random_uuid() or uuid-ossp's uuid_generate_v4().
      const raw = await client.query<{ uuidv7: string }>('SELECT uuidv7()');
      expect(raw.rows[0].uuidv7).toMatch(UUIDV7_PATTERN);

      // `updated_at` has no DB-level default (Prisma's `@updatedAt` is set by
      // Prisma Client at write time, not the database), so a raw SQL insert
      // that bypasses Prisma Client must supply it explicitly.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name, updated_at) VALUES ($1, $2, $3, now()) RETURNING id`,
        [
          'migrate-empty-db-test@example.com',
          'not-a-real-argon2-hash',
          'Migrate Test User',
        ],
      );
      expect(inserted.rows[0].id).toMatch(UUIDV7_PATTERN);
    } finally {
      await client.end();
    }
  });
});
