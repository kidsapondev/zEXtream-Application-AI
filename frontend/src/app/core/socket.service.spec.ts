import { TestBed } from '@angular/core/testing';
import { Socket } from 'socket.io-client';
import { SOCKET_FACTORY, SocketService } from './socket.service';

const socket = {
  auth: {},
  connected: false,
  connect: vi.fn(function (this: typeof socket) {
    this.connected = true;
    return this;
  }),
  disconnect: vi.fn(function (this: typeof socket) {
    this.connected = false;
    return this;
  }),
  on: vi.fn(),
  io: { on: vi.fn() },
} as unknown as Socket;

const socketFactory = vi.fn(() => socket);

/** Finds the callback a test previously registered via `socket.on(event, cb)` or `socket.io.on(event, cb)`. */
function findHandler(mock: Socket['on'] | Socket['io']['on'], event: string): (() => void) | undefined {
  const calls = (mock as unknown as { mock: { calls: [string, () => void][] } }).mock.calls;
  return calls.find(([registeredEvent]) => registeredEvent === event)?.[1];
}

describe('SocketService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.connected = false;
    socket.auth = {};
    TestBed.configureTestingModule({
      providers: [SocketService, { provide: SOCKET_FACTORY, useValue: socketFactory }],
    });
  });

  it('connects only after an access token is available', () => {
    const service = TestBed.inject(SocketService);

    expect(service.connect()).toBe(socket);
    expect(socket.connect).not.toHaveBeenCalled();

    service.setAccessToken('first-token');

    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.connect).toHaveBeenCalledOnce();
  });

  it('re-authenticates the same socket when the token changes', () => {
    const service = TestBed.inject(SocketService);
    service.setAccessToken('first-token');
    const firstSocket = service.connect();

    service.setAccessToken('second-token');

    expect(service.connect()).toBe(firstSocket);
    expect(socketFactory).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });

  it('disconnects and clears the authenticated identity on logout', () => {
    const service = TestBed.inject(SocketService);
    service.setAccessToken('first-token');
    service.connect();

    service.disconnect();

    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(service.connectionState()).toBe('disconnected');
  });

  it('starts disconnected and tracks connect/disconnect lifecycle events', () => {
    const service = TestBed.inject(SocketService);
    service.connect();
    expect(service.connectionState()).toBe('disconnected');

    findHandler(socket.on, 'connect')?.();
    expect(service.connectionState()).toBe('connected');

    findHandler(socket.on, 'disconnect')?.();
    expect(service.connectionState()).toBe('disconnected');
  });

  it('reports reconnecting while the manager retries, then connected once it succeeds', () => {
    const service = TestBed.inject(SocketService);
    service.connect();

    findHandler(socket.io.on, 'reconnect_attempt')?.();
    expect(service.connectionState()).toBe('reconnecting');

    findHandler(socket.io.on, 'reconnect')?.();
    expect(service.connectionState()).toBe('connected');
  });
});
