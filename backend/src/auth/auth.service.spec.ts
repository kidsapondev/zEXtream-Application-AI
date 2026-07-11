import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

describe('AuthService refresh rotation', () => {
  const storedRow = {
    id: 'token-1',
    userId: 'user-1',
    tokenHash: createHash('sha256').update('presented-token').digest('hex'),
    familyId: 'family-1',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    replacedById: null,
    userAgent: null,
    ipAddress: null,
  };

  function createHarness(rotationCount = 1) {
    type RotationArgs = {
      where: { id: string; revokedAt: null };
      data: { revokedAt: Date; replacedById: string };
    };
    type FamilyRevocationArgs = {
      where: { familyId: string; revokedAt: null };
      data: { revokedAt: Date };
    };
    let rotationArgs: RotationArgs | undefined;
    let familyRevocationArgs: FamilyRevocationArgs | undefined;
    const tx = {
      refreshToken: {
        create: jest.fn(({ data }: { data: unknown }) => Promise.resolve(data)),
        updateMany: jest.fn((args: RotationArgs) => {
          rotationArgs = args;
          return Promise.resolve({ count: rotationCount });
        }),
      },
    };
    const prisma = {
      refreshToken: {
        findUnique: jest.fn(() => Promise.resolve(storedRow)),
        updateMany: jest.fn((args: FamilyRevocationArgs) => {
          familyRevocationArgs = args;
          return Promise.resolve({ count: 1 });
        }),
      },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    };
    const usersService = {
      findById: jest.fn(() =>
        Promise.resolve({
          id: 'user-1',
          email: 'user@example.com',
          isActive: true,
        }),
      ),
    };
    const jwtService = {
      sign: jest.fn((payload: { jti?: string }) =>
        payload.jti ? `signed-refresh-${payload.jti}` : 'signed-access-token',
      ),
    };
    const configService = {
      getOrThrow: jest.fn((key: string) => `${key}-value`),
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    const auditLog = { record: jest.fn() };

    const service = new AuthService(
      prisma as never,
      usersService as never,
      jwtService as never,
      configService as never,
      auditLog as never,
    );

    return {
      service,
      prisma,
      tx,
      getRotationArgs: () => rotationArgs,
      getFamilyRevocationArgs: () => familyRevocationArgs,
    };
  }

  it('creates the replacement and conditionally revokes the old token in one transaction', async () => {
    const { service, prisma, tx, getRotationArgs } = createHarness();

    const tokens = await service.refresh(
      'user-1',
      'token-1',
      'presented-token',
      {},
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
    const created = tx.refreshToken.create.mock.calls[0][0].data as {
      id: string;
      tokenHash: string;
      familyId: string;
    };
    expect(created.familyId).toBe('family-1');
    expect(created.tokenHash).toBe(
      createHash('sha256').update(tokens.refreshToken).digest('hex'),
    );
    const rotation = getRotationArgs();
    expect(rotation).toBeDefined();
    if (!rotation) throw new Error('Rotation arguments were not captured');
    expect(rotation.where).toEqual({ id: 'token-1', revokedAt: null });
    expect(rotation.data.revokedAt).toBeInstanceOf(Date);
    expect(rotation.data.replacedById).toBe(created.id);
  });

  it('rolls back a losing concurrent rotation and revokes the token family', async () => {
    const { service, getFamilyRevocationArgs } = createHarness(0);

    await expect(
      service.refresh('user-1', 'token-1', 'presented-token', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const familyRevocation = getFamilyRevocationArgs();
    expect(familyRevocation).toBeDefined();
    if (!familyRevocation)
      throw new Error('Family revocation arguments were not captured');
    expect(familyRevocation.where).toEqual({
      familyId: 'family-1',
      revokedAt: null,
    });
    expect(familyRevocation.data.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a token whose hash does not match the stored row', async () => {
    const { service, prisma } = createHarness();

    await expect(
      service.refresh('user-1', 'token-1', 'different-token', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
