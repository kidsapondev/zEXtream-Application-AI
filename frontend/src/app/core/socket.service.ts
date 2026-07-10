import { inject, Injectable, InjectionToken } from '@angular/core';
import { io, ManagerOptions, Socket, SocketOptions } from 'socket.io-client';

type SocketFactory = (options: Partial<ManagerOptions & SocketOptions>) => Socket;

export const SOCKET_FACTORY = new InjectionToken<SocketFactory>('SOCKET_FACTORY', {
  providedIn: 'root',
  factory: () => (options) => io('/', options),
});

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly createSocket = inject(SOCKET_FACTORY);
  private socket: Socket | null = null;
  private accessToken: string | null = null;

  connect(): Socket {
    if (!this.socket) {
      this.socket = this.createSocket({
        path: '/ws/socket.io',
        autoConnect: false,
        auth: (cb) => cb({ token: this.accessToken }),
      });
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
  }

  get instance(): Socket {
    return this.connect();
  }
}
