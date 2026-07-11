import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [ToastService] });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('shows a toast and auto-dismisses it after the default duration', () => {
    const service = TestBed.inject(ToastService);

    service.show('Chat renamed', 'success');

    expect(service.toasts()).toHaveLength(1);
    expect(service.toasts()[0]).toMatchObject({ message: 'Chat renamed', type: 'success' });

    vi.advanceTimersByTime(3999);
    expect(service.toasts()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(service.toasts()).toHaveLength(0);
  });

  it('dismisses a toast manually before its timer fires', () => {
    const service = TestBed.inject(ToastService);

    const id = service.show('Could not delete chat', 'error');
    expect(service.toasts()).toHaveLength(1);

    service.dismiss(id);
    expect(service.toasts()).toHaveLength(0);

    // The cleared timer must not throw or dismiss anything else later.
    vi.advanceTimersByTime(5000);
    expect(service.toasts()).toHaveLength(0);
  });

  it('keeps multiple concurrent toasts independent', () => {
    const service = TestBed.inject(ToastService);

    service.show('First');
    const secondId = service.show('Second');
    expect(service.toasts().map((t) => t.message)).toEqual(['First', 'Second']);

    service.dismiss(secondId);
    expect(service.toasts().map((t) => t.message)).toEqual(['First']);
  });
});
