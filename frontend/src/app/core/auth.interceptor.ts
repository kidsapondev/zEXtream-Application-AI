import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthStore } from './auth.store';

const AUTH_ENDPOINTS = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh'];

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authStore = inject(AuthStore);
  const token = authStore.accessToken();

  const authReq = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authReq).pipe(
    catchError((error: unknown) => {
      const isAuthEndpoint = AUTH_ENDPOINTS.some((url) => req.url.includes(url));
      if (error instanceof HttpErrorResponse && error.status === 401 && !isAuthEndpoint) {
        return from(authStore.tryRefresh()).pipe(
          switchMap((refreshed) => {
            if (!refreshed) {
              return throwError(() => error);
            }
            const retryToken = authStore.accessToken();
            const retryReq = req.clone({ setHeaders: { Authorization: `Bearer ${retryToken}` } });
            return next(retryReq);
          }),
        );
      }
      return throwError(() => error);
    }),
  );
};
