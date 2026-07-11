import { io, Socket } from 'socket.io-client';

export interface TestSocketOptions {
  /** Omit for "no token sent at all"; pass any string (even a garbage one) to exercise bad-token paths. */
  token?: string | null;
}

/**
 * Builds a real socket.io-client Socket pointed at the gateway's actual path
 * (`/ws/socket.io`, see chat.gateway.ts's `@WebSocketGateway` options),
 * matching how frontend/src/app/core/socket.service.ts authenticates (an
 * `auth` callback resolving `{ token }`, not a static auth object) so a
 * later identity switch can be simulated by mutating `socket.auth` and
 * reconnecting the same instance. `autoConnect`/`reconnection` are both off:
 * tests call `.connect()` explicitly and don't want the client silently
 * retrying (and thus racing) after a deliberate bad-auth disconnect.
 */
export function createSocket(
  baseUrl: string,
  opts: TestSocketOptions = {},
): Socket {
  return io(baseUrl, {
    path: '/ws/socket.io',
    autoConnect: false,
    reconnection: false,
    transports: ['websocket'],
    auth: (cb: (data: { token: string | null | undefined }) => void) =>
      cb({ token: opts.token }),
  });
}

/** Resolves with the next `event` payload, or rejects if none arrives within `timeoutMs`. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(
        new Error(`Timed out after ${timeoutMs}ms waiting for "${event}"`),
      );
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Resolves once the socket either disconnects or fails to connect at all — either is "rejected". */
export function waitForDisconnectOrError(
  socket: Socket,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for disconnect/connect_error`,
        ),
      );
    }, timeoutMs);
    const onDisconnect = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const onError = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    function cleanup() {
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    }
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
  });
}

/** Records every `event` payload received until `.stop()` is called. */
export function collectEvents<T = unknown>(
  socket: Socket,
  event: string,
): { events: T[]; stop: () => void } {
  const events: T[] = [];
  const handler = (payload: T) => {
    events.push(payload);
  };
  socket.on(event, handler);
  return {
    events,
    stop: () => socket.off(event, handler),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
