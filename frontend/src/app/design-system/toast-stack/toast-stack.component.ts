import { Component, inject } from '@angular/core';
import { ToastService } from '../../core/toast.service';

@Component({
  selector: 'ds-toast-stack',
  template: `
    <div class="toast-stack" role="status" aria-live="polite">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast" [class.toast--error]="toast.type === 'error'">
          <span class="toast__message">{{ toast.message }}</span>
          <button
            type="button"
            class="toast__dismiss"
            (click)="toastService.dismiss(toast.id)"
            aria-label="Dismiss notification"
          >
            &times;
          </button>
        </div>
      }
    </div>
  `,
  styleUrl: './toast-stack.component.scss',
})
export class ToastStackComponent {
  protected readonly toastService = inject(ToastService);
}
