import { Component, input } from '@angular/core';

@Component({
  selector: 'ds-page-header',
  template: `
    <div class="page-header">
      <div class="page-header__row">
        <h1 class="page-header__title">{{ title() }}</h1>
        <div class="page-header__actions">
          <ng-content select="[actions]" />
        </div>
      </div>
      <div class="page-header__rule"></div>
    </div>
  `,
  styleUrl: './page-header.component.scss',
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
}
