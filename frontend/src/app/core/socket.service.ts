import { inject, Injectable, InjectionToken, signal } from '@angular/core';
import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client';

type SocketFactory = (options: Partial<ManagerOptions & SocketOptions>) => Socket;

export type SocketConnectionState = 'connected' | 'disconnected' | 'reconnecting';

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>('SOCKET_FACTORY', {
  providedIn: 'root',
  factory: () => (options) => io('/', options),
});

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly createSocket = inject(SOCKET_FACTORY);
  private socket: Socket | null = null;
  private accessToken: string | null = null;

  /** Live connection status, driven by the underlying Socket.IO client's own lifecycle events. */
  readonly connectionState = signal<SocketConnectionState>('disconnected');

  connect(): Socket {
    if (!this.socket) {
      this.socket = this.createSocket({
        path: '/ws/socket.io',
        autoConnect: false,
        auth: (cb) => cb({ token: this.accessToken }),
      });
      this.socket.on('connect', () => this.connectionState.set('connected'));
      this.socket.on('disconnect', () => this.connectionState.set('disconnected'));
      this.socket.on('connect_error', () => this.connectionState.set('disconnected'));
      this.socket.io.on('reconnect_attempt', () => this.connectionState.set('reconnecting'));
      this.socket.io.on('reconnect', () => this.connectionState.set('connected'));
    }

    if (this.accessToken && !this.socket.connected) {
      this.socket.connect();
    }

    return this.socket;
  }

  /** Re-authenticates the same Socket instance so existing event listeners are preserved. */
  setAccessToken(accessToken: string): void {
    if (accessToken === this.accessToken) return;

    this.accessToken = accessToken;
    if (!this.socket) return;

    this.socket.auth = (cb) => cb({ token: this.accessToken });
    this.socket.disconnect();
    this.socket.connect();
  }

  /** Clears the authenticated socket identity and leaves all server-side rooms. */
  disconnect(): void {
    this.accessToken = null;
    this.socket?.disconnect();
    this.connectionState.set('disconnected');
  }

  get instance(): Socket {
    return this.connect();
  }
}
