jest.mock('argon2', () => {
  const actual: typeof import('argon2') = jest.requireActual('argon2');
  return {
    ...actual,
    hash: jest.fn(() => Promise.resolve('$argon2id$dummy-hash')),
    verify: jest.fn(() => Promise.resolve(false)),
  };
});

import * as argon2 from 'argon2';
import { AuthService } from './auth.service';

describe('AuthService.validateCredentials', () => {
  function createService(findByEmail: () => Promise<unknown>) {
    const usersService = { findByEmail: jest.fn(findByEmail) };
    const configService = {
      getOrThrow: jest.fn((key: string) => `${key}-value`),
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    const service = new AuthService(
      {} as never,
      usersService as never,
      {} as never,
      configService as never,
    );
    return { service, usersService };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('still calls argon2.verify (against a cached dummy hash) when the user does not exist', async () => {
    const { service } = createService(() => Promise.resolve(null));

    const result = await service.validateCredentials(
      'nobody@example.com',
      'whatever',
    );
    // A second lookup for a different unknown email should reuse the same
    // dummy hash rather than recomputing it — see getDummyPasswordHash() in
    // auth.service.ts, which caches the hash at module scope after first use.
    await service.validateCredentials('another@example.com', 'else');

    expect(result).toBeNull();
    expect(argon2.hash).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledTimes(2);
    expect(argon2.verify).toHaveBeenCalledWith(
      '$argon2id$dummy-hash',
      'whatever',
    );
  });

  it('still calls argon2.verify (against a dummy hash) when the account is inactive', async () => {
    const { service } = createService(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'inactive@example.com',
        passwordHash: 'real-hash',
        isActive: false,
        displayName: 'Inactive',
      }),
    );

    const result = await service.validateCredentials(
      'inactive@example.com',
      'whatever',
    );

    expect(result).toBeNull();
    expect(argon2.verify).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledWith(
      '$argon2id$dummy-hash',
      'whatever',
    );
  });

  it('calls argon2.verify against the real hash when the account exists and rejects a wrong password', async () => {
    const { service } = createService(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'real-hash',
        isActive: true,
        displayName: 'User',
      }),
    );

    const result = await service.validateCredentials(
      'user@example.com',
      'wrong-password',
    );

    expect(result).toBeNull();
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(argon2.verify).toHaveBeenCalledTimes(1);
    expect(argon2.verify).toHaveBeenCalledWith('real-hash', 'wrong-password');
  });

  it('returns the user when credentials are valid', async () => {
    const { service } = createService(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'user@example.com',
        passwordHash: 'real-hash',
        isActive: true,
        displayName: 'User',
      }),
    );
    (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

    const result = await service.validateCredentials(
      'user@example.com',
      'correct-password',
    );

    expect(result).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User',
    });
  });
});
