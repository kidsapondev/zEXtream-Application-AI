export type AiProviderKey = 'ollama' | 'claude' | 'openai';

export type MessageRole = 'user' | 'assistant' | 'system';

export type StreamStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'stopped';

export type ArtifactOrigin = 'ai' | 'user';

export interface ChatSessionDto {
  id: string;
  userId: string;
  title: string;
  defaultProvider: AiProviderKey;
  defaultModel: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDto {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  provider: AiProviderKey | null;
  model: string | null;
  streamingStatus: StreamStatus;
  errorMessage: string | null;
  /**
   * Total (prompt + completion) tokens the provider reported for this exchange, when it
   * reported usage at all — `null` means unknown (older message predating this feature,
   * or the provider/stream never reached a `done` event with usage attached), not zero.
   */
  tokenCount: number | null;
  createdAt: string;
}

export interface CodeArtifactDto {
  id: string;
  messageId: string;
  sessionId: string;
  filename: string;
  language: string;
  content: string;
  revision: number;
  parentArtifactId: string | null;
  origin: ArtifactOrigin;
  createdAt: string;
}

export interface ProviderSettingDto {
  provider: AiProviderKey;
  requiresApiKey: boolean;
  configured: boolean;
  updatedAt: string | null;
  /**
   * Static model catalog for the provider. Empty for ollama (locally
   * configured, no fixed catalog — the user can run whatever they've
   * pulled). Illustrative placeholder IDs for claude/openai; see
   * backend/src/provider-settings/provider-settings.service.ts for the
   * source of truth.
   */
  models: string[];
}

/**
 * `guest` is the default role for a freshly registered account — it can log in but cannot
 * use any resource (chat, artifacts, provider settings) until an admin promotes it to
 * `user` or `admin` via the backoffice. See GuestBlockGuard (backend) and
 * `core/guest.guard.ts` (frontend).
 */
export type UserRole = 'guest' | 'user' | 'admin';

export type AdminPermission =
  | 'users_view'
  | 'users_manage_status'
  | 'users_manage_role'
  | 'users_manage_permissions'
  | 'dashboard_view'
  | 'audit_log_view';

export interface AdminUserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
}

export interface AdminUserDetailDto extends AdminUserDto {
  permissions: AdminPermission[];
}

export interface AdminUsersListDto {
  total: number;
  users: AdminUserDto[];
}

export interface AdminDashboardStatsDto {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  adminCount: number;
  /** Guests awaiting an admin to activate them (promote to `user`/`admin`). */
  pendingGuestCount: number;
  totalSessions: number;
  totalMessages: number;
  providerConfiguredCounts: Record<AiProviderKey, number>;
  /** Sum of `Message.tokenCount` across every message that reported usage. */
  totalTokensUsed: number;
  tokensByProvider: Record<AiProviderKey, number>;
}

export type AdminAuditAction =
  | 'user_role_changed'
  | 'user_status_changed'
  | 'user_permissions_changed';

export interface AdminAuditLogEntryDto {
  id: string;
  action: AdminAuditAction;
  detail: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; email: string; displayName: string } | null;
  target: { id: string; email: string; displayName: string } | null;
}

export interface AdminAuditLogListDto {
  total: number;
  entries: AdminAuditLogEntryDto[];
}

// --- WebSocket event contracts ---

export interface ClientToServerEvents {
  'session:join': (payload: { sessionId: string }) => void;
  'session:leave': (payload: { sessionId: string }) => void;
  'chat:send': (payload: {
    sessionId: string;
    content: string;
    provider?: AiProviderKey;
    model?: string;
  }) => void;
  'chat:stop': (payload: { messageId: string }) => void;
  'artifact:edit': (payload: { artifactId: string; content: string }) => void;
}

export interface ServerToClientEvents {
  'chat:message:created': (payload: { message: ChatMessageDto }) => void;
  'chat:token': (payload: { messageId: string; delta: string }) => void;
  'chat:message:updated': (payload: { message: ChatMessageDto }) => void;
  'artifact:stream:start': (payload: {
    tempId: string;
    sessionId: string;
    messageId: string;
    filename: string;
    language: string;
  }) => void;
  'artifact:stream:chunk': (payload: { tempId: string; delta: string }) => void;
  'artifact:stream:end': (payload: {
    tempId: string;
    realArtifactId: string;
    artifact?: CodeArtifactDto;
  }) => void;
  'artifact:created': (payload: { artifact: CodeArtifactDto }) => void;
  error: (payload: { code: string; message: string }) => void;
}
