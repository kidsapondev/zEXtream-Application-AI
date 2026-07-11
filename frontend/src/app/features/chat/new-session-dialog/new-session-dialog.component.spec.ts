import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AiProviderKey, ProviderSettingDto } from '@app/shared-types';
import { NewSessionDialogComponent } from './new-session-dialog.component';

function setting(overrides: Partial<ProviderSettingDto> = {}): ProviderSettingDto {
  return {
    provider: 'ollama',
    requiresApiKey: false,
    configured: true,
    updatedAt: null,
    models: [],
    ...overrides,
  };
}

@Component({
  imports: [NewSessionDialogComponent],
  template: `
    <app-new-session-dialog
      [open]="open()"
      [providers]="providers()"
      (created)="onCreated($event)"
      (cancelled)="cancelledCount = cancelledCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly providers = signal<ProviderSettingDto[]>([]);
  created: { provider: AiProviderKey; model: string } | null = null;
  cancelledCount = 0;

  onCreated(event: { provider: AiProviderKey; model: string }): void {
    this.created = event;
  }
}

describe('NewSessionDialogComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
  });

  it('defaults to Ollama with the fallback model when Ollama is among the configured providers', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([
      setting({ provider: 'ollama' }),
      setting({ provider: 'claude', requiresApiKey: true, models: ['claude-sonnet-5'] }),
    ]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    expect(dialog['selectedProvider']()).toBe('ollama');
    expect(dialog['effectiveModel']()).toBe('qwen2.5-coder:14b');
    expect(dialog['canCreate']()).toBe(true);
  });

  it('emits the selected provider and model on confirm', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([
      setting({ provider: 'ollama' }),
      setting({ provider: 'claude', requiresApiKey: true, models: ['claude-sonnet-5', 'claude-haiku-4-5'] }),
    ]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    dialog['onProviderChange']('claude');
    fixture.detectChanges();
    expect(dialog['selectedModel']()).toBe('claude-sonnet-5');

    dialog['confirm']();

    expect(fixture.componentInstance.created).toEqual({ provider: 'claude', model: 'claude-sonnet-5' });
  });

  it('disallows creating with a blank Ollama model and emits cancelled on request', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([setting({ provider: 'ollama' })]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    dialog['customOllamaModel'].set('   ');
    fixture.detectChanges();
    expect(dialog['canCreate']()).toBe(false);

    dialog.cancelled.emit();
    expect(fixture.componentInstance.cancelledCount).toBe(1);
  });
});
