import { WsRateLimiterService } from './ws-rate-limiter.service';

describe('WsRateLimiterService', () => {
  it('allows calls up to the limit within the window', () => {
    const limiter = new WsRateLimiterService();

    expect(limiter.allow('socket-1:chat:send', 3, 60_000)).toBe(true);
    expect(limiter.allow('socket-1:chat:send', 3, 60_000)).toBe(true);
    expect(limiter.allow('socket-1:chat:send', 3, 60_000)).toBe(true);
  });

  it('rejects calls once the limit is exceeded within the window', () => {
    const limiter = new WsRateLimiterService();

    limiter.allow('socket-1:chat:send', 2, 60_000);
    limiter.allow('socket-1:chat:send', 2, 60_000);

    expect(limiter.allow('socket-1:chat:send', 2, 60_000)).toBe(false);
  });

  it('tracks separate buckets per key', () => {
    const limiter = new WsRateLimiterService();

    limiter.allow('socket-1:chat:send', 1, 60_000);

    expect(limiter.allow('socket-2:chat:send', 1, 60_000)).toBe(true);
    expect(limiter.allow('socket-1:session:join', 1, 60_000)).toBe(true);
  });

  it('resets the window once it elapses', () => {
    const limiter = new WsRateLimiterService();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000);
    limiter.allow('socket-1:chat:send', 1, 60_000);
    expect(limiter.allow('socket-1:chat:send', 1, 60_000)).toBe(false);

    nowSpy.mockReturnValue(1_000 + 60_000);
    expect(limiter.allow('socket-1:chat:send', 1, 60_000)).toBe(true);

    nowSpy.mockRestore();
  });

  it("release() clears only the given socket id's buckets", () => {
    const limiter = new WsRateLimiterService();

    limiter.allow('socket-1:chat:send', 1, 60_000);
    limiter.allow('socket-2:chat:send', 1, 60_000);

    limiter.release('socket-1');

    expect(limiter.allow('socket-1:chat:send', 1, 60_000)).toBe(true);
    expect(limiter.allow('socket-2:chat:send', 1, 60_000)).toBe(false);
  });
});
