import { Injectable, inject } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { AuthStore } from './auth.store';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly authStore = inject(AuthStore);
  private socket: Socket | null = null;

  connect(): Socket {
    if (this.socket) {
      return this.socket;
    }
    this.socket = io('/', {
      path: '/ws/socket.io',
      auth: (cb) => cb({ token: this.authStore.accessToken() }),
    });
    return this.socket;
  }

  get instance(): Socket {
    return this.connect();
  }
}
