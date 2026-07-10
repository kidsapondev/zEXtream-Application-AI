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
