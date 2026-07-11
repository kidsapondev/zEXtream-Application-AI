import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateEnv } from './env.validation';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: '0123456789abcdef',
  JWT_REFRESH_SECRET: 'fedcba9876543210',
  API_KEY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

describe('validateEnv', () => {
  it('accepts plain values with no _FILE variables set', () => {
    const result = validateEnv(VALID_BASE);
    expect(result.DATABASE_URL).toBe(VALID_BASE.DATABASE_URL);
  });

  describe('secret file resolution', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'env-validation-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads a secret from a file when <KEY>_FILE is set', () => {
      const filePath = join(dir, 'jwt_access_secret');
      writeFileSync(filePath, 'secret-from-file-0123456789\n');

      const result = validateEnv({
        ...VALID_BASE,
        JWT_ACCESS_SECRET: undefined,
        JWT_ACCESS_SECRET_FILE: filePath,
      });

      expect(result.JWT_ACCESS_SECRET).toBe('secret-from-file-0123456789');
    });

    it('trims trailing whitespace/newlines from the file contents', () => {
      const filePath = join(dir, 'jwt_refresh_secret');
      writeFileSync(filePath, '  secret-with-whitespace-0123456\n\n');

      const result = validateEnv({
        ...VALID_BASE,
        JWT_REFRESH_SECRET_FILE: filePath,
      });

      expect(result.JWT_REFRESH_SECRET).toBe('secret-with-whitespace-0123456');
    });

    it('prefers the _FILE value over a plain value for the same key', () => {
      const filePath = join(dir, 'database_url');
      writeFileSync(filePath, 'postgresql://file-user:file-pass@db:5432/db');

      const result = validateEnv({
        ...VALID_BASE,
        DATABASE_URL: 'postgresql://plain-user:plain-pass@db:5432/db',
        DATABASE_URL_FILE: filePath,
      });

      expect(result.DATABASE_URL).toBe(
        'postgresql://file-user:file-pass@db:5432/db',
      );
    });

    it('throws a clear error if the referenced file does not exist', () => {
      expect(() =>
        validateEnv({
          ...VALID_BASE,
          JWT_ACCESS_SECRET_FILE: join(dir, 'does-not-exist'),
        }),
      ).toThrow();
    });

    it('ignores an empty _FILE value and falls back to the plain key', () => {
      const result = validateEnv({
        ...VALID_BASE,
        JWT_ACCESS_SECRET_FILE: '',
      });

      expect(result.JWT_ACCESS_SECRET).toBe(VALID_BASE.JWT_ACCESS_SECRET);
    });
  });
});
