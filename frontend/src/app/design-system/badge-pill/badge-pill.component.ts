import { Component, input } from '@angular/core';

export type BadgeStatus = 'positive' | 'pending' | 'negative' | 'neutral';

@Component({
  selector: 'ds-badge-pill',
  template: `<span class="badge-pill" [class]="'badge-pill--' + status()"><ng-content /></span>`,
  styleUrl: './badge-pill.component.scss',
})
export class BadgePillComponent {
  readonly status = input<BadgeStatus>('neutral');
}
