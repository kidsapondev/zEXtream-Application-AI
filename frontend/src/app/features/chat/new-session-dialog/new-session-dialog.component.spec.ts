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

  it('defaults to Ollama, picking the first entry of its live model list', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([
      setting({ provider: 'ollama', models: ['qwen2.5-coder:14b', 'llama3'] }),
      setting({ provider: 'claude', models: ['sonnet'] }),
    ]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    expect(dialog['selectedProvider']()).toBe('ollama');
    expect(dialog['selectedModel']()).toBe('qwen2.5-coder:14b');
    expect(dialog['canCreate']()).toBe(true);
  });

  it('emits the selected provider and model on confirm', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([
      setting({ provider: 'ollama', models: ['qwen2.5-coder:14b'] }),
      setting({ provider: 'claude', models: ['sonnet', 'haiku'] }),
    ]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    dialog['onProviderChange']('claude');
    fixture.detectChanges();
    expect(dialog['selectedModel']()).toBe('sonnet');

    dialog['confirm']();

    expect(fixture.componentInstance.created).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('disallows creating when the selected provider has no live models, and emits cancelled on request', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([setting({ provider: 'ollama', models: [] })]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    expect(dialog['selectedModel']()).toBe('');
    expect(dialog['canCreate']()).toBe(false);

    dialog.cancelled.emit();
    expect(fixture.componentInstance.cancelledCount).toBe(1);
  });

  it('switches the selected model to the new provider’s first live model when the provider changes', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.providers.set([
      setting({ provider: 'ollama', models: ['qwen2.5-coder:14b'] }),
      setting({ provider: 'openai', models: ['gpt-5.6-sol'] }),
    ]);
    fixture.detectChanges();

    const dialog = fixture.debugElement.query((d) => d.name === 'app-new-session-dialog')
      .componentInstance as NewSessionDialogComponent;
    dialog['onProviderChange']('openai');
    fixture.detectChanges();

    expect(dialog['selectedModel']()).toBe('gpt-5.6-sol');
  });
});
