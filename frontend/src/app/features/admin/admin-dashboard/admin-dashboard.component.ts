import { Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { AppShellComponent } from '../../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../../design-system/page-header/page-header.component';
import { StatCardComponent } from '../../../design-system/stat-card/stat-card.component';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../../core/auth.store';
import { SessionListStore } from '../../chat/session-list.store';
import { ProviderCatalogStore } from '../../chat/provider-catalog.store';
import { ToastService } from '../../../core/toast.service';
import { AdminStore } from '../admin.store';
import { AdminNavComponent } from '../admin-nav/admin-nav.component';

@Component({
  selector: 'app-admin-dashboard',
  imports: [
    RouterLink,
    DecimalPipe,
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
  private readonly providerCatalogStore = inject(ProviderCatalogStore);
  private readonly toastService = inject(ToastService);
  protected readonly adminStore = inject(AdminStore);

  protected readonly canView = computed(() =>
    this.authStore.hasPermission('dashboard_view'),
  );

  protected readonly providerEntries = computed(() => {
    const stats = this.adminStore.dashboardStats();
    const counts = stats?.providerConfiguredCounts;
    if (!counts) return [];
    return Object.entries(counts).map(([provider, userCount]) => ({
      provider,
      userCount,
      tokens: stats?.tokensByProvider?.[provider as keyof typeof counts] ?? 0,
    }));
  });

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
