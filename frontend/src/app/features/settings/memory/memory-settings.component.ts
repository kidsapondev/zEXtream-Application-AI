import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { MemoryNoteDto } from '@app/shared-types';
import { firstValueFrom } from 'rxjs';
import { AppShellComponent } from '../../../design-system/app-shell/app-shell.component';
import { PageHeaderComponent } from '../../../design-system/page-header/page-header.component';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { ConfirmDialogComponent } from '../../../design-system/confirm-dialog/confirm-dialog.component';
import { AuthStore } from '../../../core/auth.store';
import { ToastService } from '../../../core/toast.service';

/**
 * Lets a user see and delete what Phase 11's chat-memory extraction has
 * remembered about them (see backend MemoryService) — a transparency/control
 * surface, not a settings form: nothing here is configured, only reviewed.
 */
@Component({
  selector: 'app-memory-settings',
  imports: [RouterLink, AppShellComponent, PageHeaderComponent, HairlineCardComponent, ConfirmDialogComponent],
  templateUrl: './memory-settings.component.html',
  styleUrl: './memory-settings.component.scss',
})
export class MemorySettingsComponent {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  protected readonly authStore = inject(AuthStore);

  readonly notes = signal<MemoryNoteDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  protected readonly noteBeingDeleted = signal<MemoryNoteDto | null>(null);
  protected readonly confirmingDeleteAll = signal(false);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const notes = await firstValueFrom(this.http.get<MemoryNoteDto[]>('/api/settings/memory'));
      this.notes.set(notes);
    } catch {
      this.error.set('Could not load memory notes.');
    } finally {
      this.loading.set(false);
    }
  }

  protected requestDelete(note: MemoryNoteDto): void {
    this.noteBeingDeleted.set(note);
  }

  protected cancelDelete(): void {
    this.noteBeingDeleted.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const note = this.noteBeingDeleted();
    if (!note) return;
    try {
      await firstValueFrom(this.http.delete(`/api/settings/memory/${note.id}`));
      this.notes.update((list) => list.filter((n) => n.id !== note.id));
      this.toastService.show('Memory note deleted.', 'success');
    } catch {
      this.toastService.show('Could not delete this note.', 'error');
    } finally {
      this.noteBeingDeleted.set(null);
    }
  }

  protected requestDeleteAll(): void {
    if (this.notes().length === 0) return;
    this.confirmingDeleteAll.set(true);
  }

  protected cancelDeleteAll(): void {
    this.confirmingDeleteAll.set(false);
  }

  protected async confirmDeleteAll(): Promise<void> {
    try {
      await firstValueFrom(this.http.delete('/api/settings/memory'));
      this.notes.set([]);
      this.toastService.show('All memory notes deleted.', 'success');
    } catch {
      this.toastService.show('Could not delete memory notes.', 'error');
    } finally {
      this.confirmingDeleteAll.set(false);
    }
  }

  async onNewChat() {
    await this.router.navigateByUrl('/chat');
  }

  async onLogout() {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }

  async onAdmin() {
    await this.router.navigateByUrl('/admin');
  }
}
