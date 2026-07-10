import { Component, input, model } from '@angular/core';

export interface SegmentedTabOption {
  value: string;
  label: string;
}

@Component({
  selector: 'ds-segmented-tabs',
  template: `
    <div class="segmented-tabs">
      @for (option of options(); track option.value) {
        <button
          type="button"
          class="segmented-tabs__item"
          [class.segmented-tabs__item--active]="option.value === selected()"
          (click)="selected.set(option.value)"
        >
          {{ option.label }}
        </button>
      }
    </div>
  `,
  styleUrl: './segmented-tabs.component.scss',
})
export class SegmentedTabsComponent {
  readonly options = input.required<SegmentedTabOption[]>();
  readonly selected = model.required<string>();
}
