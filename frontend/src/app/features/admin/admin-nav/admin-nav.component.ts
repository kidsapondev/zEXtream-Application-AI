import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import {
  SegmentedTabsComponent,
  type SegmentedTabOption,
} from '../../../design-system/segmented-tabs/segmented-tabs.component';
import { AuthStore } from '../../../core/auth.store';

/**
 * Tab list is filtered to only the sections the current admin actually has permission for —
 * an admin with just `users_view` never sees a "Dashboard" or "Audit log" tab they'd only
 * bounce off of with a 403.
 */
@Component({
  selector: 'app-admin-nav',
  imports: [SegmentedTabsComponent],
  template: `<ds-segmented-tabs
    [options]="options()"
    [selected]="selected()"
    (selectedChange)="onSelect($event)"
  />`,
})
export class AdminNavComponent {
  private readonly router = inject(Router);
  private readonly authStore = inject(AuthStore);

  protected readonly options = computed<SegmentedTabOption[]>(() => {
    const opts: SegmentedTabOption[] = [];
    if (this.authStore.hasPermission('dashboard_view')) {
      opts.push({ value: '/admin', label: 'Dashboard' });
    }
    if (this.authStore.hasPermission('users_view')) {
      opts.push({ value: '/admin/users', label: 'Users' });
    }
    if (this.authStore.hasPermission('audit_log_view')) {
      opts.push({ value: '/admin/audit-log', label: 'Audit log' });
    }
    return opts;
  });

  private readonly currentUrl = signal(this.router.url.split('?')[0]);
  protected readonly selected = computed(() => this.currentUrl());

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => this.currentUrl.set(this.router.url.split('?')[0]));
  }

  protected onSelect(path: string): void {
    void this.router.navigateByUrl(path);
  }
}
