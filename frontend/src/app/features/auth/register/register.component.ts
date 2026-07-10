import { Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { HairlineCardComponent } from '../../../design-system/hairline-card/hairline-card.component';
import { AuthStore } from '../../../core/auth.store';

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink, HairlineCardComponent],
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss',
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    displayName: ['', [Validators.required, Validators.maxLength(100)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  async onSubmit() {
    if (this.form.invalid) {
      return;
    }
    this.submitting.set(true);
    this.errorMessage.set(null);
    try {
      const { email, password, displayName } = this.form.getRawValue();
      await this.authStore.register(email, password, displayName);
      await this.router.navigateByUrl('/chat');
    } catch {
      this.errorMessage.set('Could not create an account — the email may already be in use.');
    } finally {
      this.submitting.set(false);
    }
  }
}
