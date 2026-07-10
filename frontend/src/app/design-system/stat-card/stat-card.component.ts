import { Component, input } from '@angular/core';
import { HairlineCardComponent } from '../hairline-card/hairline-card.component';

@Component({
  selector: 'ds-stat-card',
  imports: [HairlineCardComponent],
  template: `
    <ds-hairline-card>
      <div class="stat-card">
        <div class="stat-card__icon">
          <ng-content select="[icon]" />
        </div>
        <div class="stat-card__label">{{ label() }}</div>
        <div class="stat-card__value">{{ value() }}</div>
      </div>
    </ds-hairline-card>
  `,
  styleUrl: './stat-card.component.scss',
})
export class StatCardComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
}
