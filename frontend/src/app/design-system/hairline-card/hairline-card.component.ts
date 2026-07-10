import { Component, input } from '@angular/core';

@Component({
  selector: 'ds-hairline-card',
  template: `
    <div class="hairline-card" [class.hairline-card--raised]="raised()">
      <ng-content />
    </div>
  `,
  styleUrl: './hairline-card.component.scss',
})
export class HairlineCardComponent {
  readonly raised = input(false);
}
