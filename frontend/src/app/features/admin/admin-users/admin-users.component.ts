import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { AdminPermission, AdminUserDto, UserRole } from '@app/shared-types';
import type { BadgeStatus } from '../../../design-system/badge-pill/badge-pill.component';
import { AppShellComponent } from '../../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../../design-system/page-header/page-header.component';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../../design-system/badge-pill/badge-pill.component';
import { ConfirmDialogComponent } from '../../../design-system/confirm-dialog/confirm-dialog.component';
import { AuthStore } from '../../../core/auth.store';
import { ToastService } from '../../../core/toast.service';
import { SessionListStore } from '../../chat/session-list.store';
import { ProviderCatalogStore } from '../../chat/provider-catalog.store';
import { AdminStore, ADMIN_USERS_PAGE_SIZE } from '../admin.store';
import { AdminNavComponent } from '../admin-nav/admin-nav.component';

export const PERMISSION_OPTIONS: { value: AdminPermission; label: string }[] = [
  { value: 'users_view', label: 'View users' },
  { value: 'users_manage_status', label: 'Activate / deactivate users' },
  { value: 'users_manage_role', label: 'Activate / promote / demote users' },
  { value: 'users_manage_permissions', label: 'Manage other admins’ permissions' },
  { value: 'dashboard_view', label: 'View dashboard' },
  { value: 'audit_log_view', label: 'View audit log' },
];

type PendingConfirm =
  | { type: 'deactivate'; user: AdminUserDto }
  | { type: 'demote'; user: AdminUserDto };

@Component({
  selector: 'app-admin-users',
  imports: [
    RouterLink,
    DatePipe,
    AppShellComponent,
    PageHeaderComponent,
    HairlineCardComponent,
    BadgePillComponent,
    ConfirmDialogComponent,
    AdminNavComponent,
  ],
  templateUrl: './admin-users.component.html',
  styleUrl: './admin-users.component.scss',
})
export class AdminUsersComponent {
  protected readonly router = inject(Router);
  protected readonly authStore = inject(AuthStore);
  private readonly toastService = inject(ToastService);
  private readonly sessionListStore = inject(SessionListStore);
  private readonly providerCatalogStore = inject(ProviderCatalogStore);
  protected readonly adminStore = inject(AdminStore);

  protected readonly permissionOptions = PERMISSION_OPTIONS;
  protected readonly pageSize = ADMIN_USERS_PAGE_SIZE;

  protected readonly canView = computed(() =>
    this.authStore.hasPermission('users_view'),
  );
  protected readonly canManageStatus = computed(() =>
    this.authStore.hasPermission('users_manage_status'),
  );
  protected readonly canManageRole = computed(() =>
    this.authStore.hasPermission('users_manage_role'),
  );
  protected readonly canManagePermissions = computed(() =>
    this.authStore.hasPermission('users_manage_permissions'),
  );

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.adminStore.usersTotal() / this.pageSize)),
  );

  protected readonly searchInput = signal('');
  protected readonly savingUserId = signal<string | null>(null);
  protected readonly expandedUserId = signal<string | null>(null);
  protected readonly permissionDraft = signal<Set<AdminPermission>>(new Set());
  protected readonly pendingConfirm = signal<PendingConfirm | null>(null);

  isSelf(userId: string): boolean {
    return this.authStore.currentUser()?.id === userId;
  }

  onSearchInput(value: string): void {
    this.searchInput.set(value);
  }

  applySearch(): void {
    this.adminStore.setUserSearch(this.searchInput());
  }

  goToPage(delta: number): void {
    const next = this.adminStore.userPageIndex() + delta;
    if (next < 0 || next >= this.totalPages()) return;
    this.adminStore.userPageIndex.set(next);
  }

  requestDeactivate(user: AdminUserDto): void {
    if (!user.isActive) {
      void this.setStatus(user, true);
      return;
    }
    this.pendingConfirm.set({ type: 'deactivate', user });
  }

  /**
   * guest -> user ("Activate") and user -> admin ("Promote") are both non-destructive
   * grants, applied immediately. admin -> user ("Demote") is the only direction that
   * removes access, so it's the only one that goes through the confirm dialog.
   */
  requestRoleChange(user: AdminUserDto): void {
    if (user.role === 'guest') {
      void this.setRole(user, 'user');
      return;
    }
    if (user.role === 'user') {
      void this.setRole(user, 'admin');
      return;
    }
    this.pendingConfirm.set({ type: 'demote', user });
  }

  roleActionLabel(user: AdminUserDto): string {
    if (user.role === 'guest') return 'Activate';
    if (user.role === 'user') return 'Promote to admin';
    return 'Demote to user';
  }

  roleBadgeStatus(role: UserRole): BadgeStatus {
    if (role === 'admin') return 'positive';
    if (role === 'guest') return 'pending';
    return 'neutral';
  }

  async confirmPending(): Promise<void> {
    const pending = this.pendingConfirm();
    this.pendingConfirm.set(null);
    if (!pending) return;
    if (pending.type === 'deactivate') {
      await this.setStatus(pending.user, false);
    } else {
      await this.setRole(pending.user, 'user');
    }
  }

  private async setStatus(user: AdminUserDto, isActive: boolean): Promise<void> {
    this.savingUserId.set(user.id);
    try {
      await this.adminStore.updateUserStatus(user.id, isActive);
      this.toastService.show(
        `${user.email} ${isActive ? 'activated' : 'deactivated'}.`,
        'success',
      );
    } catch {
      this.toastService.show(`Could not update ${user.email}.`, 'error');
    } finally {
      this.savingUserId.set(null);
    }
  }

  private async setRole(user: AdminUserDto, role: UserRole): Promise<void> {
    this.savingUserId.set(user.id);
    try {
      await this.adminStore.updateUserRole(user.id, role);
      this.toastService.show(`${user.email} is now ${role}.`, 'success');
      if (this.expandedUserId() === user.id) this.expandedUserId.set(null);
    } catch {
      this.toastService.show(`Could not update ${user.email}.`, 'error');
    } finally {
      this.savingUserId.set(null);
    }
  }

  async togglePermissionEditor(user: AdminUserDto): Promise<void> {
    if (this.expandedUserId() === user.id) {
      this.expandedUserId.set(null);
      return;
    }
    this.expandedUserId.set(user.id);
    try {
      const detail = await this.adminStore.loadUserDetail(user.id);
      this.permissionDraft.set(new Set(detail.permissions));
    } catch {
      this.toastService.show(`Could not load permissions for ${user.email}.`, 'error');
      this.expandedUserId.set(null);
    }
  }

  isPermissionChecked(permission: AdminPermission): boolean {
    return this.permissionDraft().has(permission);
  }

  togglePermission(permission: AdminPermission, checked: boolean): void {
    this.permissionDraft.update((set) => {
      const next = new Set(set);
      if (checked) next.add(permission);
      else next.delete(permission);
      return next;
    });
  }

  async savePermissions(user: AdminUserDto): Promise<void> {
    this.savingUserId.set(user.id);
    try {
      await this.adminStore.updateUserPermissions(
        user.id,
        Array.from(this.permissionDraft()),
      );
      this.toastService.show(`Permissions updated for ${user.email}.`, 'success');
      this.expandedUserId.set(null);
    } catch {
      this.toastService.show(`Could not update permissions for ${user.email}.`, 'error');
    } finally {
      this.savingUserId.set(null);
    }
  }

  async onNewChat(): Promise<void> {
    const [provider] = this.providerCatalogStore.configuredProviders();
    if (!provider) {
      this.toastService.show('No AI provider is currently available.', 'error');
      return;
    }
    const session = await this.sessionListStore.createSession(
      provider.provider,
      provider.models[0],
    );
    await this.router.navigate(['/chat', session.id]);
  }

  async onLogout(): Promise<void> {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }
}
