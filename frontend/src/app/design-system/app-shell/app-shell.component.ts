import { Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { IconRailComponent } from '../icon-rail/icon-rail.component';
import { SecondarySidebarComponent } from '../secondary-sidebar/secondary-sidebar.component';

@Component({
  selector: 'ds-app-shell',
  imports: [IconRailComponent, SecondarySidebarComponent],
  template: `
    <div class="app-shell">
      <ds-icon-rail
        [userInitial]="userInitial()"
        [menuOpen]="sidebarOpen()"
        (newChat)="newChat.emit()"
        (settings)="settings.emit()"
        (menuToggle)="sidebarOpen.set(!sidebarOpen())"
      />

      <div
        class="app-shell__backdrop"
        [class.app-shell__backdrop--visible]="sidebarOpen()"
        (click)="sidebarOpen.set(false)"
      ></div>

      <ds-secondary-sidebar [title]="sidebarTitle()" [open]="sidebarOpen()">
        <div header-extra><ng-content select="[sidebar-header-extra]" /></div>
        <div list><ng-content select="[sidebar-list]" /></div>
        <div footer><ng-content select="[sidebar-footer]" /></div>
      </ds-secondary-sidebar>

      <main class="app-shell__main">
        <ng-content select="[main]" />
      </main>
    </div>
  `,
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  readonly sidebarTitle = input.required<string>();
  readonly userInitial = input('U');
  readonly newChat = output<void>();
  readonly settings = output<void>();

  protected readonly sidebarOpen = signal(false);

  constructor() {
    const router = inject(Router);
    router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => this.sidebarOpen.set(false));
  }
}
