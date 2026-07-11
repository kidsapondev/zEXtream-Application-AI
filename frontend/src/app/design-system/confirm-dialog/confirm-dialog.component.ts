import { Component, ElementRef, afterRenderEffect, input, output, viewChild } from '@angular/core';

/**
 * Small reusable confirm/cancel modal. Deliberately minimal: a backdrop, a
 * title, a message and two buttons styled like the `.btn`/`.btn--primary`/
 * `.btn--danger` classes already used in `provider-settings.component.scss`.
 *
 * Traps focus between the two buttons, closes on Escape or a backdrop click,
 * and defaults focus to Cancel so an accidental Enter keypress never
 * confirms a destructive action.
 */
@Component({
  selector: 'ds-confirm-dialog',
  template: `
    @if (open()) {
      <div class="confirm-dialog__backdrop" (click)="cancelled.emit()">
        <div
          #dialogEl
          class="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          [attr.aria-labelledby]="titleId"
          [attr.aria-describedby]="message() ? messageId : null"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown.escape)="cancelled.emit()"
          (keydown.tab)="onTab($event)"
        >
          <h2 [id]="titleId" class="confirm-dialog__title">{{ title() }}</h2>
          @if (message()) {
            <p [id]="messageId" class="confirm-dialog__message">{{ message() }}</p>
          }
          <div class="confirm-dialog__actions">
            <button #cancelBtn type="button" class="btn" (click)="cancelled.emit()">
              {{ cancelLabel() }}
            </button>
            <button
              #confirmBtn
              type="button"
              class="btn"
              [class.btn--danger]="danger()"
              [class.btn--primary]="!danger()"
              (click)="confirmed.emit()"
            >
              {{ confirmLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './confirm-dialog.component.scss',
})
export class ConfirmDialogComponent {
  readonly open = input(false);
  readonly title = input('Are you sure?');
  readonly message = input('');
  readonly confirmLabel = input('Confirm');
  readonly cancelLabel = input('Cancel');
  readonly danger = input(true);

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly titleId = `confirm-dialog-title-${crypto.randomUUID()}`;
  protected readonly messageId = `confirm-dialog-message-${crypto.randomUUID()}`;

  private readonly cancelBtn = viewChild<ElementRef<HTMLButtonElement>>('cancelBtn');
  private readonly confirmBtn = viewChild<ElementRef<HTMLButtonElement>>('confirmBtn');

  constructor() {
    afterRenderEffect(() => {
      if (!this.open()) return;
      this.cancelBtn()?.nativeElement.focus();
    });
  }

  protected onTab(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    const cancel = this.cancelBtn()?.nativeElement;
    const confirm = this.confirmBtn()?.nativeElement;
    if (!cancel || !confirm) return;
    const active = document.activeElement;

    if (keyboardEvent.shiftKey && active === cancel) {
      keyboardEvent.preventDefault();
      confirm.focus();
    } else if (!keyboardEvent.shiftKey && active === confirm) {
      keyboardEvent.preventDefault();
      cancel.focus();
    }
  }
}
