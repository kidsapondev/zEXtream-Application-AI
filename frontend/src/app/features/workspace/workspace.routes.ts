import { Routes } from '@angular/router';

/**
 * Child routes for the web IDE, kept in the feature rather than inlined into
 * `app.routes.ts`.
 *
 * The IDE is being assembled by several efforts at once (the shell here, a bottom dock, an
 * AI side panel) and every one of them may eventually want a route of its own — a diff view,
 * a search results page. Pointing the app router at this file once means those land here
 * instead of turning the app-level route table into a merge conflict.
 */
export const workspaceRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./workspace-page.component').then((m) => m.WorkspacePageComponent),
  },
];
