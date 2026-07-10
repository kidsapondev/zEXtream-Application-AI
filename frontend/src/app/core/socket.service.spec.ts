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
} as unknown as Socket;

const socketFactory = vi.fn(() => socket);

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
  });
});
