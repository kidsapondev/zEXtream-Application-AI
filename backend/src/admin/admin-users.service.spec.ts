import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';

describe('AdminUsersService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  };
  const permissionsService = {
    listForUser: jest.fn(),
    replaceForUser: jest.fn(),
    revokeAllForUser: jest.fn(),
  };
  const auditService = { record: jest.fn() };
  const service = new AdminUsersService(
    prisma as never,
    permissionsService as never,
    auditService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('self-lockout guard', () => {
    it('rejects updateStatus when the target is the actor', async () => {
      await expect(
        service.updateStatus('u1', 'u1', false),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects updateRole when the target is the actor', async () => {
      await expect(
        service.updateRole('u1', 'u1', 'user'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects updatePermissions when the target is the actor', async () => {
      await expect(
        service.updatePermissions('u1', 'u1', []),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('updateStatus throws NotFoundException for a missing target', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.updateStatus('actor', 'missing', false),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateRole revokes all permission grants when demoting to user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      role: 'admin',
      isActive: true,
    });
    const tx = {
      user: {
        update: jest.fn().mockResolvedValue({ id: 'target', role: 'user' }),
      },
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    await service.updateRole('actor', 'target', 'user');

    const updateCall = tx.user.update.mock.calls[0] as [
      { where: { id: string }; data: { role: string }; select: unknown },
    ];
    expect(updateCall[0].where).toEqual({ id: 'target' });
    expect(updateCall[0].data).toEqual({ role: 'user' });
    expect(updateCall[0].select).toBeDefined();
    expect(permissionsService.revokeAllForUser).toHaveBeenCalledWith(
      'target',
      tx,
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'actor',
        targetUserId: 'target',
        action: 'user_role_changed',
      }),
    );
  });

  it('updateRole does not touch permission grants when promoting to admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      role: 'user',
      isActive: true,
    });
    const tx = {
      user: {
        update: jest.fn().mockResolvedValue({ id: 'target', role: 'admin' }),
      },
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    await service.updateRole('actor', 'target', 'admin');

    expect(permissionsService.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('updatePermissions rejects a target whose role is not admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      role: 'user',
      isActive: true,
    });

    await expect(
      service.updatePermissions('actor', 'target', ['users_view']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(permissionsService.replaceForUser).not.toHaveBeenCalled();
  });

  it('updatePermissions replaces the permission set for an admin target', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'target',
      role: 'admin',
      isActive: true,
    });
    permissionsService.listForUser.mockResolvedValue(['users_view']);

    const result = await service.updatePermissions('actor', 'target', [
      'users_view',
      'dashboard_view',
    ]);

    expect(permissionsService.replaceForUser).toHaveBeenCalledWith(
      'target',
      ['users_view', 'dashboard_view'],
      'actor',
    );
    expect(result).toEqual({
      permissions: ['users_view', 'dashboard_view'],
    });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user_permissions_changed' }),
    );
  });
});
