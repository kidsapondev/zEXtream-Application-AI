import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AppShellComponent } from '../../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../../design-system/page-header/page-header.component';
import { StatCardComponent } from '../../../design-system/stat-card/stat-card.component';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../../core/auth.store';
import { SessionListStore } from '../../chat/session-list.store';
import { AdminStore } from '../admin.store';
import { AdminNavComponent } from '../admin-nav/admin-nav.component';

const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:14b';

@Component({
  selector: 'app-admin-dashboard',
  imports: [
    RouterLink,
    AppShellComponent,
    PageHeaderComponent,
    StatCardComponent,
    HairlineCardComponent,
    BadgePillComponent,
    AdminNavComponent,
  ],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.scss',
})
export class AdminDashboardComponent {
  protected readonly router = inject(Router);
  protected readonly authStore = inject(AuthStore);
  private readonly sessionListStore = inject(SessionListStore);
  protected readonly adminStore = inject(AdminStore);

  protected readonly canView = computed(() =>
    this.authStore.hasPermission('dashboard_view'),
  );

  protected readonly providerEntries = computed(() => {
    const counts = this.adminStore.dashboardStats()?.providerConfiguredCounts;
    if (!counts) return [];
    return Object.entries(counts) as [string, number][];
  });

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
