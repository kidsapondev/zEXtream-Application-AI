import { Component, input, output } from '@angular/core';

@Component({
  selector: 'ds-icon-rail',
  template: `
    <nav class="icon-rail">
      <button
        type="button"
        class="icon-rail__menu-toggle"
        (click)="menuToggle.emit()"
        [attr.aria-label]="menuOpen() ? 'Close menu' : 'Open menu'"
        [attr.aria-expanded]="menuOpen()"
      >
        @if (menuOpen()) {
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        } @else {
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        }
      </button>

      <div class="icon-rail__logo" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M12 2 L22 12 L12 22 L2 12 Z" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </div>

      <div class="icon-rail__badge">{{ userInitial() }}</div>

      <button type="button" class="icon-rail__action" (click)="newChat.emit()" aria-label="New chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <div class="icon-rail__spacer"></div>

      <button type="button" class="icon-rail__action" (click)="settings.emit()" aria-label="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15 1.65 1.65 0 0 0 3.17 14H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            stroke="currentColor"
            stroke-width="1.5"
          />
        </svg>
      </button>
    </nav>
  `,
  styleUrl: './icon-rail.component.scss',
})
export class IconRailComponent {
  readonly userInitial = input('U');
  readonly menuOpen = input(false);
  readonly newChat = output<void>();
  readonly settings = output<void>();
  readonly menuToggle = output<void>();
}
