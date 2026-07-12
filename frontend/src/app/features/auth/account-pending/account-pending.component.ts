import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { BadgePillComponent } from '../../../design-system/badge-pill/badge-pill.component';
import { AuthStore } from '../../../core/auth.store';

/**
 * Shown to a `guest` account instead of the app — new registrations start as `guest` and
 * can't use any resource (chat, artifacts, provider settings) until an admin promotes them.
 * Reached right after register/login (see login/register components) and guarded so an
 * already-activated account never lands here (see core/guest.guard.ts's `onlyGuestGuard`).
 */
@Component({
  selector: 'app-account-pending',
  imports: [HairlineCardComponent, BadgePillComponent],
  templateUrl: './account-pending.component.html',
  styleUrl: './account-pending.component.scss',
})
export class AccountPendingComponent {
  protected readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  async onLogout(): Promise<void> {
    await this.authStore.logout();
    await this.router.navigateByUrl('/login');
  }
}
