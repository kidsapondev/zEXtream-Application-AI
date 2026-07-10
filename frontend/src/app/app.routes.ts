import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/auth/register/register.component').then((m) => m.RegisterComponent),
  },
  {
    path: 'chat',
    canMatch: [authGuard],
    loadComponent: () => import('./features/chat/chat-workspace.component').then((m) => m.ChatWorkspaceComponent),
  },
  {
    path: 'chat/:sessionId',
    canMatch: [authGuard],
    loadComponent: () => import('./features/chat/chat-workspace.component').then((m) => m.ChatWorkspaceComponent),
  },
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  { path: '**', redirectTo: 'chat' },
];
