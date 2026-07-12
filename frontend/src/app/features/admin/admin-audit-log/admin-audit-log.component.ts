import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { AdminAuditAction } from '@app/shared-types';
import { AppShellComponent } from '../../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../../design-system/page-header/page-header.component';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../../core/auth.store';
import { SessionListStore } from '../../chat/session-list.store';
import { AdminStore, ADMIN_AUDIT_PAGE_SIZE } from '../admin.store';
import { AdminNavComponent } from '../admin-nav/admin-nav.component';

const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:14b';

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  user_role_changed: 'Role changed',
  user_status_changed: 'Status changed',
  user_permissions_changed: 'Permissions changed',
};

@Component({
  selector: 'app-admin-audit-log',
  imports: [
    RouterLink,
    DatePipe,
    AppShellComponent,
    PageHeaderComponent,
    HairlineCardComponent,
    BadgePillComponent,
    AdminNavComponent,
  ],
  templateUrl: './admin-audit-log.component.html',
  styleUrl: './admin-audit-log.component.scss',
})
export class AdminAuditLogComponent {
  protected readonly router = inject(Router);
  protected readonly authStore = inject(AuthStore);
  private readonly sessionListStore = inject(SessionListStore);
  protected readonly adminStore = inject(AdminStore);

  protected readonly pageSize = ADMIN_AUDIT_PAGE_SIZE;
  protected readonly actionLabels = ACTION_LABELS;

  protected readonly canView = computed(() =>
    this.authStore.hasPermission('audit_log_view'),
  );

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.adminStore.auditTotal() / this.pageSize)),
  );

  goToPage(delta: number): void {
    const next = this.adminStore.auditPageIndex() + delta;
    if (next < 0 || next >= this.totalPages()) return;
    this.adminStore.auditPageIndex.set(next);
  }

  detailSummary(detail: Record<string, unknown>): string {
    return JSON.stringify(detail);
  }

  async onNewChat(): Promise<void> {
    const session = await this.sessionListStore.createSession(
      'ollama',
      DEFAULT_OLLAMA_MODEL,
    );
    await this.router.navigate(['/chat', session.id]);
  }

  async onLogout(): Promise<void> {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }
}
