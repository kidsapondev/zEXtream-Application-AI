import { Component, input } from '@angular/core';

@Component({
  selector: 'ds-secondary-sidebar',
  template: `
    <aside class="secondary-sidebar" [class.secondary-sidebar--open]="open()">
      <div class="secondary-sidebar__header">
        <h2 class="secondary-sidebar__title">{{ title() }}</h2>
        <ng-content select="[header-extra]" />
      </div>

      <div class="secondary-sidebar__list">
        <ng-content select="[list]" />
      </div>

      <div class="secondary-sidebar__footer">
        <ng-content select="[footer]" />
      </div>
    </aside>
  `,
  styleUrl: './secondary-sidebar.component.scss',
})
export class SecondarySidebarComponent {
  readonly title = input.required<string>();
  readonly open = input(false);
}
