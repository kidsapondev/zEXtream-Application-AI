import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { adminGuard } from './core/admin.guard';
import { guestGuard, onlyGuestGuard } from './core/guest.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/auth/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./features/auth/register/register.component').then((m) => m.RegisterComponent),
  },
  {
    path: 'account-pending',
    canMatch: [authGuard, onlyGuestGuard],
    loadComponent: () =>
      import('./features/auth/account-pending/account-pending.component').then(
        (m) => m.AccountPendingComponent,
      ),
  },
  {
    path: 'chat',
    canMatch: [authGuard, guestGuard],
    loadComponent: () =>
      import('./features/chat/chat-workspace.component').then((m) => m.ChatWorkspaceComponent),
  },
  {
    path: 'chat/:sessionId',
    canMatch: [authGuard, guestGuard],
    loadComponent: () =>
      import('./features/chat/chat-workspace.component').then((m) => m.ChatWorkspaceComponent),
  },
  {
    path: 'settings/providers',
    canMatch: [authGuard, guestGuard],
    loadComponent: () =>
      import('./features/settings/provider-settings.component').then(
        (m) => m.ProviderSettingsComponent,
      ),
  },
  {
    path: 'admin',
    canMatch: [authGuard, guestGuard, adminGuard],
    loadComponent: () =>
      import('./features/admin/admin-dashboard/admin-dashboard.component').then(
        (m) => m.AdminDashboardComponent,
      ),
  },
  {
    path: 'admin/users',
    canMatch: [authGuard, guestGuard, adminGuard],
    loadComponent: () =>
      import('./features/admin/admin-users/admin-users.component').then(
        (m) => m.AdminUsersComponent,
      ),
  },
  {
    path: 'admin/audit-log',
    canMatch: [authGuard, guestGuard, adminGuard],
    loadComponent: () =>
      import('./features/admin/admin-audit-log/admin-audit-log.component').then(
        (m) => m.AdminAuditLogComponent,
      ),
  },
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  { path: '**', redirectTo: 'chat' },
];
