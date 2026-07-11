import {
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ChatSessionDto } from '@app/shared-types';
import { ConfirmDialogComponent } from '../../../design-system/confirm-dialog/confirm-dialog.component';
import { ToastService } from '../../../core/toast.service';
import { SessionListStore } from '../session-list.store';

@Component({
  selector: 'app-session-list-item',
  imports: [RouterLink, FormsModule, ConfirmDialogComponent],
  templateUrl: './session-list-item.component.html',
  styleUrl: './session-list-item.component.scss',
})
export class SessionListItemComponent {
  readonly session = input.required<ChatSessionDto>();
  readonly active = input(false);
  readonly changeProvider = output<ChatSessionDto>();

  private readonly sessionListStore = inject(SessionListStore);
  private readonly toastService = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly editing = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly busy = signal(false);
  protected readonly confirmingDelete = signal(false);

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  constructor() {
    afterRenderEffect(() => {
      if (!this.editing()) return;
      const input = this.titleInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  startRename(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.draftTitle.set(this.session().title);
    this.editing.set(true);
  }

  cancelRename(): void {
    this.editing.set(false);
  }

  requestProviderChange(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.changeProvider.emit(this.session());
  }

  async commitRename(): Promise<void> {
    if (!this.editing()) return;
    this.editing.set(false);

    const title = this.draftTitle().trim();
    if (!title || title === this.session().title) return;

    try {
      await this.sessionListStore.renameSession(this.session().id, title);
      this.toastService.show('Chat renamed.', 'success');
    } catch {
      this.toastService.show('Could not rename this chat.', 'error');
    }
  }

  async archive(event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.busy.set(true);
    try {
      await this.sessionListStore.archiveSession(this.session().id);
      this.toastService.show('Chat archived.', 'success');
      if (this.active()) await this.router.navigateByUrl('/chat');
    } catch {
      this.toastService.show('Could not archive this chat.', 'error');
    } finally {
      this.busy.set(false);
    }
  }

  requestDelete(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.confirmingDelete.set(true);
  }

  cancelDelete(): void {
    this.confirmingDelete.set(false);
  }

  async confirmDelete(): Promise<void> {
    this.confirmingDelete.set(false);
    this.busy.set(true);
    try {
      await this.sessionListStore.deleteSession(this.session().id);
      this.toastService.show('Chat deleted.', 'success');
      if (this.active()) await this.router.navigateByUrl('/chat');
    } catch {
      this.toastService.show('Could not delete this chat.', 'error');
    } finally {
      this.busy.set(false);
    }
  }
}
