import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

function contextWithUser(user: { id: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const usersService = { findById: jest.fn() };
  const permissionsService = { hasAll: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new PermissionsGuard(
    reflector as unknown as Reflector,
    usersService as never,
    permissionsService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects when there is no authenticated user on the request', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);

    await expect(
      guard.canActivate(contextWithUser(undefined)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('rejects a non-admin user even with no specific permission required', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    usersService.findById.mockResolvedValue({
      id: 'u1',
      role: 'user',
      isActive: true,
    });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a deactivated admin', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    usersService.findById.mockResolvedValue({
      id: 'u1',
      role: 'admin',
      isActive: false,
    });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an admin when no specific permission is required', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    usersService.findById.mockResolvedValue({
      id: 'u1',
      role: 'admin',
      isActive: true,
    });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
    expect(permissionsService.hasAll).not.toHaveBeenCalled();
  });

  it('rejects an admin missing the required permission', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users_view']);
    usersService.findById.mockResolvedValue({
      id: 'u1',
      role: 'admin',
      isActive: true,
    });
    permissionsService.hasAll.mockResolvedValue(false);

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an admin holding the required permission', async () => {
    reflector.getAllAndOverride.mockReturnValue(['users_view']);
    usersService.findById.mockResolvedValue({
      id: 'u1',
      role: 'admin',
      isActive: true,
    });
    permissionsService.hasAll.mockResolvedValue(true);

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
    expect(permissionsService.hasAll).toHaveBeenCalledWith('u1', [
      'users_view',
    ]);
  });
});
