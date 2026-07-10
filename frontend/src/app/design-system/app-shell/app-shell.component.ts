import { Component, input, output } from '@angular/core';
import { IconRailComponent } from '../icon-rail/icon-rail.component';
import { SecondarySidebarComponent } from '../secondary-sidebar/secondary-sidebar.component';

@Component({
  selector: 'ds-app-shell',
  imports: [IconRailComponent, SecondarySidebarComponent],
  template: `
    <div class="app-shell">
      <ds-icon-rail [userInitial]="userInitial()" (newChat)="newChat.emit()" (settings)="settings.emit()" />

      <ds-secondary-sidebar [title]="sidebarTitle()">
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
}
