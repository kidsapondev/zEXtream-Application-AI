import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthStore, type CurrentUser } from './auth.store';
import { SocketService } from './socket.service';

/**
 * doRefresh() chains a second HTTP call (loadCurrentUser()) after awaiting the first
 * one's response, so flushing the first request doesn't synchronously produce the
 * second — it needs a tick for the intervening microtasks (the await, signal writes,
 * socketService call) to run first.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    role: 'user',
    permissions: [],
    ...overrides,
  };
}

describe('AuthStore', () => {
  const socketService = {
    setAccessToken: vi.fn(),
    disconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        AuthStore,
        { provide: SocketService, useValue: socketService },
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('starts unauthenticated with no user', () => {
    const store = TestBed.inject(AuthStore);

    expect(store.isAuthenticated()).toBe(false);
    expect(store.currentUser()).toBeNull();
    expect(store.accessToken()).toBeNull();
  });

  it('login() stores the access token/user and re-authenticates the socket', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);
    const loggedInUser = user();

    const pending = store.login('test@example.com', 'password123');
    const req = http.expectOne('/api/auth/login');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.body).toEqual({ email: 'test@example.com', password: 'password123' });
    req.flush({ user: loggedInUser, accessToken: 'access-token-1' });
    await pending;

    expect(store.isAuthenticated()).toBe(true);
    expect(store.accessToken()).toBe('access-token-1');
    expect(store.currentUser()).toEqual(loggedInUser);
    expect(socketService.setAccessToken).toHaveBeenCalledWith('access-token-1');
  });

  it('login() leaves the store unauthenticated when the request fails', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);

    const pending = store.login('test@example.com', 'wrong-password');
    const req = http.expectOne('/api/auth/login');
    req.flush({ message: 'Invalid credentials' }, { status: 401, statusText: 'Unauthorized' });

    await expect(pending).rejects.toBeTruthy();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.currentUser()).toBeNull();
    expect(socketService.setAccessToken).not.toHaveBeenCalled();
  });

  it('register() stores the access token/user and re-authenticates the socket', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);
    const registeredUser = user({ id: 'user-2', email: 'new@example.com' });

    const pending = store.register('new@example.com', 'password123', 'New User');
    const req = http.expectOne('/api/auth/register');
    expect(req.request.body).toEqual({
      email: 'new@example.com',
      password: 'password123',
      displayName: 'New User',
    });
    req.flush({ user: registeredUser, accessToken: 'access-token-2' });
    await pending;

    expect(store.accessToken()).toBe('access-token-2');
    expect(store.currentUser()).toEqual(registeredUser);
    expect(socketService.setAccessToken).toHaveBeenCalledWith('access-token-2');
  });

  it('tryRefresh() exchanges the refresh cookie for a new access token and loads the current user', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);
    const refreshedUser = user({ displayName: 'Refreshed User' });

    const pending = store.tryRefresh();
    const refreshReq = http.expectOne('/api/auth/refresh');
    expect(refreshReq.request.withCredentials).toBe(true);
    refreshReq.flush({ accessToken: 'access-token-3' });
    await flushMicrotasks();
    const meReq = http.expectOne('/api/users/me');
    meReq.flush(refreshedUser);

    expect(await pending).toBe(true);
    expect(store.accessToken()).toBe('access-token-3');
    expect(store.currentUser()).toEqual(refreshedUser);
    expect(socketService.setAccessToken).toHaveBeenCalledWith('access-token-3');
  });

  it('tryRefresh() clears state and disconnects the socket when the refresh cookie is invalid/expired', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);

    const pending = store.tryRefresh();
    const refreshReq = http.expectOne('/api/auth/refresh');
    refreshReq.flush({ message: 'Invalid refresh token' }, { status: 401, statusText: 'Unauthorized' });

    expect(await pending).toBe(false);
    expect(store.isAuthenticated()).toBe(false);
    expect(store.currentUser()).toBeNull();
    expect(socketService.disconnect).toHaveBeenCalled();
  });

  it('tryRefresh() shares one in-flight attempt across concurrent callers instead of issuing duplicate requests', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);

    const first = store.tryRefresh();
    const second = store.tryRefresh();

    const refreshReq = http.expectOne('/api/auth/refresh');
    refreshReq.flush({ accessToken: 'access-token-4' });
    await flushMicrotasks();
    const meReq = http.expectOne('/api/users/me');
    meReq.flush(user());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);

    // A subsequent call after the first has settled starts a genuinely new attempt.
    const third = store.tryRefresh();
    http.expectOne('/api/auth/refresh').flush({ accessToken: 'access-token-5' });
    await flushMicrotasks();
    http.expectOne('/api/users/me').flush(user());
    expect(await third).toBe(true);
  });

  it('logout() clears state and disconnects the socket even if the request fails', async () => {
    const store = TestBed.inject(AuthStore);
    const http = TestBed.inject(HttpTestingController);

    const loginPending = store.login('test@example.com', 'password123');
    http.expectOne('/api/auth/login').flush({ user: user(), accessToken: 'access-token-1' });
    await loginPending;

    const pending = store.logout();
    const req = http.expectOne('/api/auth/logout');
    req.flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    await expect(pending).rejects.toBeTruthy();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.currentUser()).toBeNull();
    expect(socketService.disconnect).toHaveBeenCalled();
  });
});
