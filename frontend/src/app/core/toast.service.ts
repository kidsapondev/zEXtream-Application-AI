import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

/**
 * Minimal signal-based notification store, following the same pattern as
 * `AuthStore`/`ChatStore`: state lives in a signal, consumers read it directly
 * instead of subscribing to an Observable.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  private nextId = 0;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Shows a toast and auto-dismisses it after `durationMs`. Returns the toast id. */
  show(message: string, type: ToastType = 'success', durationMs = 4000): string {
    const id = `toast-${++this.nextId}`;
    this._toasts.update((list) => [...list, { id, message, type }]);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), durationMs),
    );
    return id;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts.update((list) => list.filter((toast) => toast.id !== id));
  }
}
