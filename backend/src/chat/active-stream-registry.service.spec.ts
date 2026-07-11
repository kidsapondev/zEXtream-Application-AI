import { ActiveStreamRegistry } from './active-stream-registry.service';

describe('ActiveStreamRegistry', () => {
  let registry: ActiveStreamRegistry;

  beforeEach(() => {
    registry = new ActiveStreamRegistry();
  });

  it('registers a controller and reports the session as streaming', () => {
    expect(registry.hasActiveStream('session-1')).toBe(false);

    registry.register('message-1', 'session-1');

    expect(registry.hasActiveStream('session-1')).toBe(true);
  });

  it('stop() aborts the registered controller and returns true', () => {
    const controller = registry.register('message-1', 'session-1');

    const result = registry.stop('message-1');

    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('stop() on an unknown messageId returns false and does not throw', () => {
    expect(() => registry.stop('unknown-message')).not.toThrow();
    expect(registry.stop('unknown-message')).toBe(false);
  });

  it('release() removes the entry so the session is no longer reported as streaming', () => {
    registry.register('message-1', 'session-1');

    registry.release('message-1');

    expect(registry.hasActiveStream('session-1')).toBe(false);
  });

  it('release() on an already-released or unknown id does not throw', () => {
    registry.register('message-1', 'session-1');
    registry.release('message-1');

    expect(() => registry.release('message-1')).not.toThrow();
    expect(() => registry.release('never-registered')).not.toThrow();
  });

  it('keeps a session streaming while any of its messages are still registered', () => {
    registry.register('message-1', 'session-1');
    registry.register('message-2', 'session-1');

    registry.release('message-1');

    expect(registry.hasActiveStream('session-1')).toBe(true);

    registry.release('message-2');

    expect(registry.hasActiveStream('session-1')).toBe(false);
  });

  it('tracks streams independently per session', () => {
    registry.register('message-1', 'session-1');
    registry.register('message-2', 'session-2');

    expect(registry.hasActiveStream('session-1')).toBe(true);
    expect(registry.hasActiveStream('session-2')).toBe(true);

    registry.release('message-1');

    expect(registry.hasActiveStream('session-1')).toBe(false);
    expect(registry.hasActiveStream('session-2')).toBe(true);
  });

  describe('stopAllForSession', () => {
    it('aborts every controller registered under a session and clears them', () => {
      const controllerA = registry.register('message-1', 'session-1');
      const controllerB = registry.register('message-2', 'session-1');
      const otherSessionController = registry.register(
        'message-3',
        'session-2',
      );

      registry.stopAllForSession('session-1');

      expect(controllerA.signal.aborted).toBe(true);
      expect(controllerB.signal.aborted).toBe(true);
      expect(otherSessionController.signal.aborted).toBe(false);
      expect(registry.hasActiveStream('session-1')).toBe(false);
      expect(registry.hasActiveStream('session-2')).toBe(true);
    });

    it('is a no-op for a session with no active streams and does not throw', () => {
      expect(() => registry.stopAllForSession('unknown-session')).not.toThrow();
    });

    it('leaves a later stop()/release() on an already-cleared message a safe no-op', () => {
      registry.register('message-1', 'session-1');

      registry.stopAllForSession('session-1');

      expect(() => registry.stop('message-1')).not.toThrow();
      expect(registry.stop('message-1')).toBe(false);
      expect(() => registry.release('message-1')).not.toThrow();
    });
  });

  describe('onApplicationShutdown', () => {
    it('aborts every in-flight stream across every session', () => {
      const controllerA = registry.register('message-1', 'session-1');
      const controllerB = registry.register('message-2', 'session-2');

      registry.onApplicationShutdown('SIGTERM');

      expect(controllerA.signal.aborted).toBe(true);
      expect(controllerB.signal.aborted).toBe(true);
      expect(registry.hasActiveStream('session-1')).toBe(false);
      expect(registry.hasActiveStream('session-2')).toBe(false);
    });

    it('is a no-op when nothing is streaming and does not throw', () => {
      expect(() => registry.onApplicationShutdown('SIGTERM')).not.toThrow();
    });
  });
});
