import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GuestBlockGuard } from './guest-block.guard';

function contextWithUser(user: { id: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('GuestBlockGuard', () => {
  const usersService = { findById: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new GuestBlockGuard(
    reflector as unknown as Reflector,
    usersService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows a @Public() route without looking up the user', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true); // isPublic

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('allows an @AllowGuest() route without looking up the user', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // isPublic
      .mockReturnValueOnce(true); // allowGuest

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('allows the request through when there is no authenticated user on it', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);

    await expect(guard.canActivate(contextWithUser(undefined))).resolves.toBe(
      true,
    );
    expect(usersService.findById).not.toHaveBeenCalled();
  });

  it('rejects a guest on a default (non-allowlisted) route', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    usersService.findById.mockResolvedValue({ id: 'u1', role: 'guest' });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a user-role account through on a default route', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    usersService.findById.mockResolvedValue({ id: 'u1', role: 'user' });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
  });

  it('allows an admin-role account through on a default route', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    usersService.findById.mockResolvedValue({ id: 'u1', role: 'admin' });

    await expect(
      guard.canActivate(contextWithUser({ id: 'u1' })),
    ).resolves.toBe(true);
  });
});
