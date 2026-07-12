import { INestApplication } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, registerUser } from './support/test-app';

/**
 * Backoffice permission-gating integration tests (plan.md Phase 8). Registers real users
 * through the normal REST flow, then promotes/grants permissions directly via Prisma (the
 * same shortcut artifacts-ownership.e2e-spec.ts uses) rather than driving a bootstrap-admin
 * email through env vars, which would require restarting the app mid-suite.
 */
describe('Admin backoffice (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    ({ app, prisma } = await createE2eApp());
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeAdmin(userId: string, permissions: AdminPermission[]) {
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'admin' },
    });
    if (permissions.length > 0) {
      await prisma.adminPermissionGrant.createMany({
        data: permissions.map((permission) => ({ userId, permission })),
      });
    }
  }

  it('denies an unauthenticated request to every admin endpoint', async () => {
    await request(app.getHttpServer()).get('/api/admin/users').expect(401);
    await request(app.getHttpServer()).get('/api/admin/dashboard').expect(401);
    await request(app.getHttpServer()).get('/api/admin/audit-log').expect(401);
  });

  it('denies a plain user (role=user) access to admin endpoints', async () => {
    const plain = await registerUser(app, 'admin-plain-user');
    createdUserIds.push(plain.user.id);

    await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${plain.accessToken}`)
      .expect(403);
  });

  it('denies an admin who lacks the specific permission required by a route', async () => {
    const admin = await registerUser(app, 'admin-missing-perm');
    createdUserIds.push(admin.user.id);
    await makeAdmin(admin.user.id, [AdminPermission.users_view]);

    // Has users_view (can list) but not users_manage_status (cannot toggle isActive).
    await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const other = await registerUser(app, 'admin-target-1');
    createdUserIds.push(other.user.id);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${other.user.id}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(403);
  });

  it('lets an admin with users_manage_status toggle another user and records an audit entry', async () => {
    const admin = await registerUser(app, 'admin-status-manager');
    createdUserIds.push(admin.user.id);
    await makeAdmin(admin.user.id, [AdminPermission.users_manage_status]);

    const target = await registerUser(app, 'admin-target-2');
    createdUserIds.push(target.user.id);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${target.user.id}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(200);

    const updated = await prisma.user.findUnique({
      where: { id: target.user.id },
    });
    expect(updated?.isActive).toBe(false);

    const auditEntries = await prisma.adminAuditLogEntry.findMany({
      where: { targetUserId: target.user.id, action: 'user_status_changed' },
    });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].actorUserId).toBe(admin.user.id);
  });

  it('refuses to let an admin change their own status, role, or permissions', async () => {
    const admin = await registerUser(app, 'admin-self-lockout');
    createdUserIds.push(admin.user.id);
    await makeAdmin(admin.user.id, [
      AdminPermission.users_manage_status,
      AdminPermission.users_manage_role,
      AdminPermission.users_manage_permissions,
    ]);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${admin.user.id}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ isActive: false })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${admin.user.id}/role`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ role: 'user' })
      .expect(400);

    await request(app.getHttpServer())
      .put(`/api/admin/users/${admin.user.id}/permissions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ permissions: [] })
      .expect(400);
  });

  it('demoting an admin to a plain user revokes all of their permission grants', async () => {
    const superAdmin = await registerUser(app, 'admin-role-manager');
    createdUserIds.push(superAdmin.user.id);
    await makeAdmin(superAdmin.user.id, [AdminPermission.users_manage_role]);

    const target = await registerUser(app, 'admin-target-3');
    createdUserIds.push(target.user.id);
    await makeAdmin(target.user.id, [
      AdminPermission.users_view,
      AdminPermission.dashboard_view,
    ]);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${target.user.id}/role`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send({ role: 'user' })
      .expect(200);

    const remainingGrants = await prisma.adminPermissionGrant.findMany({
      where: { userId: target.user.id },
    });
    expect(remainingGrants).toHaveLength(0);

    const updated = await prisma.user.findUnique({
      where: { id: target.user.id },
    });
    expect(updated?.role).toBe('user');
  });

  it('rejects granting permissions to a target whose role is not admin', async () => {
    const superAdmin = await registerUser(app, 'admin-perm-manager');
    createdUserIds.push(superAdmin.user.id);
    await makeAdmin(superAdmin.user.id, [
      AdminPermission.users_manage_permissions,
    ]);

    const plainTarget = await registerUser(app, 'admin-target-4');
    createdUserIds.push(plainTarget.user.id);

    await request(app.getHttpServer())
      .put(`/api/admin/users/${plainTarget.user.id}/permissions`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send({ permissions: [AdminPermission.users_view] })
      .expect(400);
  });

  it('returns dashboard stats only to an admin with dashboard_view', async () => {
    const admin = await registerUser(app, 'admin-dashboard-viewer');
    createdUserIds.push(admin.user.id);
    await makeAdmin(admin.user.id, [AdminPermission.dashboard_view]);

    const response = await request(app.getHttpServer())
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const body = response.body as {
      totalUsers: number;
      activeUsers: number;
      adminCount: number;
      pendingGuestCount: number;
      providerConfiguredCounts: unknown;
    };
    expect(typeof body.totalUsers).toBe('number');
    expect(typeof body.activeUsers).toBe('number');
    expect(typeof body.adminCount).toBe('number');
    expect(typeof body.pendingGuestCount).toBe('number');
    expect(typeof body.providerConfiguredCounts).toBe('object');
  });

  it('revoking a permission blocks the very next request from the same, still-unexpired access token', async () => {
    const superAdmin = await registerUser(app, 'admin-revoke-super');
    createdUserIds.push(superAdmin.user.id);
    await makeAdmin(superAdmin.user.id, [
      AdminPermission.users_manage_permissions,
    ]);

    const target = await registerUser(app, 'admin-revoke-target');
    createdUserIds.push(target.user.id);
    await makeAdmin(target.user.id, [AdminPermission.dashboard_view]);

    // Same access token used both before and after the revoke — proves PermissionsGuard
    // re-checks the database on every request instead of trusting a claim baked into the
    // JWT at login time.
    await request(app.getHttpServer())
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .put(`/api/admin/users/${target.user.id}/permissions`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send({ permissions: [] })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(403);
  });

  it('includes role=guest and an empty permissions array for a freshly registered account', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({
        email: `admin-response-shape-${Date.now()}@example.com`,
        password: 'IntegrationPassword123!',
        displayName: 'shape-check',
      })
      .expect(201);

    const body = response.body as {
      user: { id: string; role: string; permissions: string[] };
    };
    createdUserIds.push(body.user.id);
    expect(body.user.role).toBe('guest');
    expect(body.user.permissions).toEqual([]);
  });

  it('blocks a freshly registered guest from every resource endpoint but still lets it read /api/users/me', async () => {
    const guest = await registerUser(app, 'admin-guest-blocked', {
      role: 'guest',
    });
    createdUserIds.push(guest.user.id);

    await request(app.getHttpServer())
      .get('/api/chat/sessions')
      .set('Authorization', `Bearer ${guest.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/chat/sessions')
      .set('Authorization', `Bearer ${guest.accessToken}`)
      .send({ defaultProvider: 'ollama', defaultModel: 'test-model' })
      .expect(403);

    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${guest.accessToken}`)
      .expect(200);
    expect((me.body as { role: string }).role).toBe('guest');
  });

  it('lets a guest use the app immediately once an admin promotes them to user', async () => {
    const superAdmin = await registerUser(app, 'admin-guest-promoter');
    createdUserIds.push(superAdmin.user.id);
    await makeAdmin(superAdmin.user.id, [AdminPermission.users_manage_role]);

    const guest = await registerUser(app, 'admin-guest-activated', {
      role: 'guest',
    });
    createdUserIds.push(guest.user.id);

    await request(app.getHttpServer())
      .patch(`/api/admin/users/${guest.user.id}/role`)
      .set('Authorization', `Bearer ${superAdmin.accessToken}`)
      .send({ role: 'user' })
      .expect(200);

    // Same access token as before promotion — proves the check is re-read from the
    // database on every request, not cached in the JWT the guest already holds.
    await request(app.getHttpServer())
      .get('/api/chat/sessions')
      .set('Authorization', `Bearer ${guest.accessToken}`)
      .expect(200);
  });
});
