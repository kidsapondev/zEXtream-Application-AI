import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AiProviderKey, ProviderSettingDto } from '@app/shared-types';
import {
  SegmentedTabsComponent,
  type SegmentedTabOption,
} from '../../../design-system/segmented-tabs/segmented-tabs.component';

/**
 * Provider + model picker shown when starting a new chat (and reused, in
 * principle, wherever a provider/model choice is needed — see
 * `chat-workspace.component.ts` for the one current call site).
 *
 * Every provider's model list — including Ollama's — comes from `providers()`
 * (`GET /api/settings/providers`, backed by a live check: Ollama's `/api/tags`,
 * claude/openai's host-bridge status — see `ProviderSettingsService`), so this
 * only ever offers models that are genuinely usable right now, never a
 * hardcoded guess.
 *
 * Deliberately a bespoke dialog rather than a reuse of `ds-confirm-dialog`:
 * that component's contract is a yes/no question with two buttons, not a
 * form with two dependent selects, so bending it to fit would fight its API
 * more than it would save. It mirrors `ds-confirm-dialog`'s visual language
 * instead (backdrop, card, Escape/backdrop-click to cancel, focus handling)
 * so the two dialogs feel like the same system.
 */
@Component({
  selector: 'app-new-session-dialog',
  imports: [FormsModule, SegmentedTabsComponent],
  templateUrl: './new-session-dialog.component.html',
  styleUrl: './new-session-dialog.component.scss',
})
export class NewSessionDialogComponent {
  readonly open = input(false);
  readonly initialChoice = input<{ provider: AiProviderKey; model: string } | null>(null);
  readonly editing = input(false);
  /** Only providers the current user can actually start a session with (`configured: true`). */
  readonly providers = input<ProviderSettingDto[]>([]);

  readonly created = output<{ provider: AiProviderKey; model: string }>();
  readonly cancelled = output<void>();

  protected readonly selectedProvider = signal<AiProviderKey>('ollama');
  protected readonly selectedModel = signal('');

  protected readonly providerOptions = computed<SegmentedTabOption[]>(() =>
    this.providers().map((p) => ({ value: p.provider, label: providerLabel(p.provider) })),
  );

  protected readonly currentProviderSetting = computed<ProviderSettingDto | undefined>(() =>
    this.providers().find((p) => p.provider === this.selectedProvider()),
  );

  protected readonly modelOptions = computed<SegmentedTabOption[]>(() =>
    (this.currentProviderSetting()?.models ?? []).map((model) => ({ value: model, label: model })),
  );

  protected readonly canCreate = computed(() => this.selectedModel().length > 0);

  private readonly dialogEl = viewChild<ElementRef<HTMLDivElement>>('dialogEl');

  constructor() {
    // Re-initialize selection whenever the dialog is (re)opened with a fresh provider list —
    // prefer Ollama (always available, no key needed) as the least-surprise default.
    effect(() => {
      if (!this.open()) return;
      const providers = this.providers();
      const initial = this.initialChoice();
      const preferred =
        providers.find((p) => p.provider === initial?.provider) ??
        providers.find((p) => p.provider === 'ollama') ??
        providers[0];
      if (!preferred) return;
      this.selectedProvider.set(preferred.provider);
      this.selectedModel.set(
        preferred.models.includes(initial?.model ?? '')
          ? (initial?.model ?? '')
          : (preferred.models[0] ?? ''),
      );
    });

    // Keep the model selection valid whenever the provider (or its live model list) changes.
    effect(() => {
      const setting = this.currentProviderSetting();
      if (!setting) return;
      if (!setting.models.includes(this.selectedModel())) {
        this.selectedModel.set(setting.models[0] ?? '');
      }
    });

    afterRenderEffect(() => {
      if (this.open()) this.dialogEl()?.nativeElement.focus();
    });
  }

  protected onProviderChange(provider: string): void {
    this.selectedProvider.set(provider as AiProviderKey);
  }

  protected confirm(): void {
    if (!this.canCreate()) return;
    this.created.emit({ provider: this.selectedProvider(), model: this.selectedModel() });
  }
}

function providerLabel(provider: AiProviderKey): string {
  switch (provider) {
    case 'ollama':
      return 'Ollama';
    case 'claude':
      return 'Claude';
    case 'openai':
      return 'OpenAI';
  }
}
