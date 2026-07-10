import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import 'tslib';
import { SocketService } from './socket.service';

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

interface AuthResponse {
  user: CurrentUser;
  accessToken: string;
}

interface RefreshResponse {
  accessToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);

  readonly accessToken = signal<string | null>(null);
  readonly currentUser = signal<CurrentUser | null>(null);
  readonly isAuthenticated = computed(() => this.accessToken() !== null);

  private inFlightRefresh: Promise<boolean> | null = null;

  async login(email: string, password: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<AuthResponse>('/api/auth/login', { email, password }, { withCredentials: true }),
    );
    this.accessToken.set(res.accessToken);
    this.currentUser.set(res.user);
    this.socketService.setAccessToken(res.accessToken);
  }

  async register(email: string, password: string, displayName: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<AuthResponse>(
        '/api/auth/register',
        { email, password, displayName },
        { withCredentials: true },
      ),
    );
    this.accessToken.set(res.accessToken);
    this.currentUser.set(res.user);
    this.socketService.setAccessToken(res.accessToken);
  }

  /**
   * Silently exchanges the httpOnly refresh cookie for a new access token.
   * Concurrent callers (e.g. several requests 401-ing at once) share one in-flight attempt.
   */
  tryRefresh(): Promise<boolean> {
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.doRefresh().finally(() => {
        this.inFlightRefresh = null;
      });
    }
    return this.inFlightRefresh;
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.post<RefreshResponse>('/api/auth/refresh', {}, { withCredentials: true }),
      );
      this.accessToken.set(res.accessToken);
      this.socketService.setAccessToken(res.accessToken);
      await this.loadCurrentUser();
      return true;
    } catch {
      this.accessToken.set(null);
      this.currentUser.set(null);
      this.socketService.disconnect();
      return false;
    }
  }

  async loadCurrentUser(): Promise<void> {
    const user = await firstValueFrom(this.http.get<CurrentUser>('/api/users/me'));
    this.currentUser.set(user);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}, { withCredentials: true }));
    } finally {
      this.accessToken.set(null);
      this.currentUser.set(null);
      this.socketService.disconnect();
    }
  }
}
