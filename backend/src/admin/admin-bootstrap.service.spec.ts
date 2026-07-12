import { AdminBootstrapService } from './admin-bootstrap.service';

describe('AdminBootstrapService', () => {
  const configService = { get: jest.fn() };
  const usersService = { findByEmail: jest.fn() };
  const prisma = { user: { update: jest.fn() } };
  const permissionsService = { grantAll: jest.fn() };
  const service = new AdminBootstrapService(
    configService as never,
    usersService as never,
    prisma as never,
    permissionsService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get.mockReturnValue(['bootstrap@example.com']);
  });

  it('is a no-op for an email not in BOOTSTRAP_ADMIN_EMAILS', async () => {
    await service.ensureBootstrapAdmin('someone-else@example.com');

    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(permissionsService.grantAll).not.toHaveBeenCalled();
  });

  it('is a no-op when the listed email has not registered yet', async () => {
    usersService.findByEmail.mockResolvedValue(null);

    await service.ensureBootstrapAdmin('bootstrap@example.com');

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(permissionsService.grantAll).not.toHaveBeenCalled();
  });

  it('promotes a registered non-admin to admin and grants every permission', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'u1',
      role: 'user',
    });

    await service.ensureBootstrapAdmin('bootstrap@example.com');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: 'admin' },
    });
    expect(permissionsService.grantAll).toHaveBeenCalledWith('u1', null);
  });

  it('re-grants every permission even if already admin, without re-issuing the role update', async () => {
    usersService.findByEmail.mockResolvedValue({
      id: 'u1',
      role: 'admin',
    });

    await service.ensureBootstrapAdmin('bootstrap@example.com');

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(permissionsService.grantAll).toHaveBeenCalledWith('u1', null);
  });

  it('matches case-insensitively and trims the input email', async () => {
    usersService.findByEmail.mockResolvedValue({ id: 'u1', role: 'admin' });

    await service.ensureBootstrapAdmin('  Bootstrap@Example.com  ');

    expect(usersService.findByEmail).toHaveBeenCalledWith(
      'bootstrap@example.com',
    );
  });

  it('onApplicationBootstrap ensures every configured email', async () => {
    configService.get.mockReturnValue(['a@example.com', 'b@example.com']);
    usersService.findByEmail.mockResolvedValue({ id: 'u1', role: 'admin' });

    await service.onApplicationBootstrap();

    expect(usersService.findByEmail).toHaveBeenCalledTimes(2);
    expect(usersService.findByEmail).toHaveBeenCalledWith('a@example.com');
    expect(usersService.findByEmail).toHaveBeenCalledWith('b@example.com');
  });
});
