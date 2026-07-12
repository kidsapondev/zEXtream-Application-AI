import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, httpResource } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminAuditLogListDto,
  AdminDashboardStatsDto,
  AdminPermission,
  AdminUserDetailDto,
  AdminUsersListDto,
  UserRole,
} from '@app/shared-types';
import { AuthStore } from '../../core/auth.store';

export const ADMIN_USERS_PAGE_SIZE = 20;
export const ADMIN_AUDIT_PAGE_SIZE = 25;

/**
 * Backoffice read/write access, gated per-resource by the current user's specific
 * permission (not just the `admin` role AdminGuard already checked at the route level) —
 * each `httpResource` returns `undefined` (no request issued) when the permission is
 * missing, mirroring how ProviderCatalogStore/SessionListStore gate on `isAuthenticated()`.
 */
@Injectable({ providedIn: 'root' })
export class AdminStore {
  private readonly http = inject(HttpClient);
  private readonly authStore = inject(AuthStore);

  readonly userSearch = signal('');
  readonly userPageIndex = signal(0);

  private readonly usersResource = httpResource<AdminUsersListDto>(() => {
    if (!this.authStore.hasPermission('users_view')) return undefined;
    const params = new URLSearchParams();
    const query = this.userSearch().trim();
    if (query) params.set('query', query);
    params.set('limit', String(ADMIN_USERS_PAGE_SIZE));
    params.set('offset', String(this.userPageIndex() * ADMIN_USERS_PAGE_SIZE));
    return `/api/admin/users?${params.toString()}`;
  });

  readonly users = computed(() => this.usersResource.value()?.users ?? []);
  readonly usersTotal = computed(() => this.usersResource.value()?.total ?? 0);
  readonly usersLoading = this.usersResource.isLoading;
  readonly usersError = computed(() => this.usersResource.error() != null);

  private readonly dashboardResource = httpResource<AdminDashboardStatsDto>(() =>
    this.authStore.hasPermission('dashboard_view') ? '/api/admin/dashboard' : undefined,
  );

  readonly dashboardStats = this.dashboardResource.value;
  readonly dashboardLoading = this.dashboardResource.isLoading;
  readonly dashboardError = computed(() => this.dashboardResource.error() != null);

  readonly auditPageIndex = signal(0);

  private readonly auditResource = httpResource<AdminAuditLogListDto>(() => {
    if (!this.authStore.hasPermission('audit_log_view')) return undefined;
    const params = new URLSearchParams();
    params.set('limit', String(ADMIN_AUDIT_PAGE_SIZE));
    params.set('offset', String(this.auditPageIndex() * ADMIN_AUDIT_PAGE_SIZE));
    return `/api/admin/audit-log?${params.toString()}`;
  });

  readonly auditEntries = computed(() => this.auditResource.value()?.entries ?? []);
  readonly auditTotal = computed(() => this.auditResource.value()?.total ?? 0);
  readonly auditLoading = this.auditResource.isLoading;
  readonly auditError = computed(() => this.auditResource.error() != null);

  setUserSearch(query: string): void {
    this.userSearch.set(query);
    this.userPageIndex.set(0);
  }

  loadUserDetail(userId: string): Promise<AdminUserDetailDto> {
    return firstValueFrom(
      this.http.get<AdminUserDetailDto>(`/api/admin/users/${userId}`),
    );
  }

  async updateUserStatus(userId: string, isActive: boolean): Promise<void> {
    await firstValueFrom(
      this.http.patch(`/api/admin/users/${userId}/status`, { isActive }),
    );
    this.usersResource.reload();
  }

  async updateUserRole(userId: string, role: UserRole): Promise<void> {
    await firstValueFrom(
      this.http.patch(`/api/admin/users/${userId}/role`, { role }),
    );
    this.usersResource.reload();
  }

  async updateUserPermissions(
    userId: string,
    permissions: AdminPermission[],
  ): Promise<void> {
    await firstValueFrom(
      this.http.put(`/api/admin/users/${userId}/permissions`, {
        permissions,
      }),
    );
    this.usersResource.reload();
  }
}
