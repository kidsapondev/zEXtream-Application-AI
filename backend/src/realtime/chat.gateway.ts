import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { ChatSessionsService } from '../chat/chat-sessions.service';
import { MessagesService } from '../chat/messages.service';
import { AiProviderFactory } from '../ai/ai-provider.factory';
import { ActiveStreamRegistry } from './active-stream-registry.service';
import { AiMessage } from '../ai/ai-provider.interface';
import { ArtifactStreamParser } from '../ai/artifact-stream-parser';
import {
  ArtifactsService,
  assertArtifactContentBytes,
  normalizeArtifactFilename,
} from '../artifacts/artifacts.service';
import { SessionJoinDto } from './dto/session-join.dto';
import { SessionLeaveDto } from './dto/session-leave.dto';
import { ChatStopDto } from './dto/chat-stop.dto';
import { ArtifactEditDto } from './dto/artifact-edit.dto';
import { ChatSendDto } from './dto/chat-send.dto';
import { WsValidationFilter } from './ws-validation.filter';

interface AccessTokenPayload {
  sub: string;
  email: string;
}

const SYSTEM_PROMPT = `When you write code that creates or edits a file, wrap it in a fenced code block using this exact format:
\`\`\`language:relative/path/filename.ext
...code...
\`\`\`
Always include the filename after a colon in the fence info string. For short inline snippets that aren't a file, use regular single backticks instead.`;

function artifactContextMessage(
  artifacts: Array<{ filename: string; language: string; content: string }>,
): string | null {
  if (artifacts.length === 0) return null;
  const files = artifacts
    .map(
      (artifact) =>
        `<file path="${artifact.filename}" language="${artifact.language}">\n${artifact.content}\n</file>`,
    )
    .join('\n\n');
  return `These are the latest files in the current workspace. Preserve them when making edits and use their exact relative paths:\n${files}`;
}

@WebSocketGateway({
  path: '/ws/socket.io',
  cors: { origin: process.env.CORS_ORIGIN, credentials: true },
})
// Global pipes/filters from main.ts do not reach WS handlers (see
// ws-validation.filter.ts for why), so both must be declared explicitly here
// to match the REST-side ValidationPipe options and give validation failures
// a client-visible error shape instead of an unhandled/unknown exception.
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@UseFilters(WsValidationFilter)
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionsService: ChatSessionsService,
    private readonly messagesService: MessagesService,
    private readonly aiProviderFactory: AiProviderFactory,
    private readonly streamRegistry: ActiveStreamRegistry,
    private readonly artifactsService: ArtifactsService,
  ) {}

  handleConnection(client: Socket) {
    const token = client.handshake.auth?.['token'] as string | undefined;
    if (!token) {
      client.disconnect();
      return;
    }
    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      this.socketData(client)['userId'] = payload.sub;
    } catch {
      client.disconnect();
    }
  }

  @SubscribeMessage('session:join')
  async onSessionJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SessionJoinDto,
  ) {
    await this.sessionsService.getOwned(this.userId(client), body.sessionId);
    await client.join(this.roomName(body.sessionId));
  }

  @SubscribeMessage('session:leave')
  async onSessionLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: SessionLeaveDto,
  ) {
    await client.leave(this.roomName(body.sessionId));
  }

  @SubscribeMessage('chat:stop')
  async onChatStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatStopDto,
  ) {
    const isOwner = await this.messagesService.isOwnedByUser(
      body.messageId,
      this.userId(client),
    );
    if (!isOwner) return;
    this.streamRegistry.stop(body.messageId);
  }

  @SubscribeMessage('artifact:edit')
  async onArtifactEdit(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ArtifactEditDto,
  ) {
    const existing = await this.artifactsService.getById(body.artifactId);
    if (!existing) return;
    await this.sessionsService.getOwned(
      this.userId(client),
      existing.sessionId,
    );

    const updated = await this.artifactsService.createRevision({
      sessionId: existing.sessionId,
      messageId: existing.messageId,
      filename: existing.filename,
      language: existing.language,
      content: body.content,
      origin: 'user',
    });
    this.server
      .to(this.roomName(existing.sessionId))
      .emit('artifact:created', { artifact: updated });
  }

  @SubscribeMessage('chat:send')
  async onChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChatSendDto,
  ) {
    const userId = this.userId(client);
    const session = await this.sessionsService.getOwned(userId, body.sessionId);
    const room = this.roomName(body.sessionId);
    const providerKey = body.provider ?? session.defaultProvider;
    const model = body.model ?? session.defaultModel;

    if (!this.aiProviderFactory.hasProvider(providerKey)) {
      throw new WsException(`AI provider "${providerKey}" is not enabled`);
    }

    const userMessage = await this.messagesService.createUserMessage(
      body.sessionId,
      body.content,
    );
    this.server.to(room).emit('chat:message:created', { message: userMessage });
    await this.sessionsService.touch(body.sessionId);

    const assistantMessage =
      await this.messagesService.createPendingAssistantMessage(
        body.sessionId,
        providerKey,
        model,
      );
    this.server
      .to(room)
      .emit('chat:message:created', { message: assistantMessage });

    const history = await this.messagesService.listForSession(body.sessionId);
    const latestArtifacts = await this.artifactsService.listLatestForSession(
      body.sessionId,
    );
    const currentFiles = artifactContextMessage(latestArtifacts);
    const aiMessages: AiMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(currentFiles
        ? [{ role: 'system' as const, content: currentFiles }]
        : []),
      ...history
        .filter((m) => m.id !== assistantMessage.id)
        .map((m) => ({
          role: m.role,
          content: m.content,
        })),
    ];

    const parser = new ArtifactStreamParser();
    let proseContent = '';
    let finalStatus: 'complete' | 'error' | 'stopped' = 'complete';
    let finalErrorMessage: string | undefined;
    let controller: AbortController | undefined;

    let currentArtifact: {
      tempId: string;
      filename: string;
      language: string;
      content: string;
      contentBytes: number;
    } | null = null;

    const handleSegments = async (
      segments: ReturnType<ArtifactStreamParser['push']>,
    ) => {
      for (const segment of segments) {
        if (segment.type === 'prose') {
          proseContent += segment.text;
          this.server.to(room).emit('chat:token', {
            messageId: assistantMessage.id,
            delta: segment.text,
          });
        } else if (segment.type === 'artifact-start') {
          currentArtifact = {
            tempId: randomUUID(),
            filename: normalizeArtifactFilename(segment.filename),
            language: segment.language,
            content: '',
            contentBytes: 0,
          };
          this.server.to(room).emit('artifact:stream:start', {
            tempId: currentArtifact.tempId,
            sessionId: body.sessionId,
            messageId: assistantMessage.id,
            filename: currentArtifact.filename,
            language: currentArtifact.language,
          });
        } else if (segment.type === 'artifact-chunk' && currentArtifact) {
          const chunkBytes = Buffer.byteLength(segment.text, 'utf8');
          try {
            assertArtifactContentBytes(
              currentArtifact.contentBytes + chunkBytes,
            );
          } catch (error) {
            // Do not let the final parser flush turn an oversized partial stream
            // into an empty artifact revision after the stream has failed.
            currentArtifact = null;
            throw error;
          }
          currentArtifact.content += segment.text;
          currentArtifact.contentBytes += chunkBytes;
          this.server.to(room).emit('artifact:stream:chunk', {
            tempId: currentArtifact.tempId,
            delta: segment.text,
          });
        } else if (segment.type === 'artifact-end' && currentArtifact) {
          const saved = await this.artifactsService.createRevision({
            sessionId: body.sessionId,
            messageId: assistantMessage.id,
            filename: currentArtifact.filename,
            language: currentArtifact.language,
            content: currentArtifact.content,
            origin: 'ai',
          });
          this.server.to(room).emit('artifact:stream:end', {
            tempId: currentArtifact.tempId,
            realArtifactId: saved.id,
            artifact: saved,
          });
          currentArtifact = null;
        }
      }
    };

    try {
      const provider = this.aiProviderFactory.getProvider(providerKey);
      controller = this.streamRegistry.register(assistantMessage.id);

      for await (const event of provider.streamChat({
        messages: aiMessages,
        model,
        abortSignal: controller.signal,
      })) {
        if (event.type === 'token') {
          await handleSegments(parser.push(event.delta));
        } else if (event.type === 'done') {
          finalStatus =
            event.finishReason === 'stopped' ? 'stopped' : 'complete';
        } else if (event.type === 'error') {
          finalStatus = 'error';
          finalErrorMessage = event.message;
          this.logger.error(
            `AI stream error for message ${assistantMessage.id}: ${event.message}`,
          );
          break;
        }
      }
    } catch (error) {
      finalStatus = controller?.signal.aborted ? 'stopped' : 'error';
      finalErrorMessage =
        error instanceof Error ? error.message : 'AI stream failed';
      this.logger.error(
        `AI stream failed for message ${assistantMessage.id}`,
        error,
      );
    } finally {
      try {
        await handleSegments(parser.flush());
      } catch (error) {
        finalStatus = 'error';
        finalErrorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to finalize streamed content';
        this.logger.error(
          `Artifact stream finalization failed for message ${assistantMessage.id}`,
          error,
        );
      }

      if (controller) {
        this.streamRegistry.release(assistantMessage.id);
      }

      const updated = await this.messagesService.finalizeAssistantMessage(
        assistantMessage.id,
        proseContent,
        finalStatus,
        finalErrorMessage,
      );
      this.server.to(room).emit('chat:message:updated', { message: updated });
    }
  }

  private roomName(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private socketData(client: Socket): Record<string, unknown> {
    const data: unknown = client.data;
    if (!data || typeof data !== 'object') {
      throw new WsException('Socket authentication state is invalid');
    }
    return data as Record<string, unknown>;
  }

  private userId(client: Socket): string {
    const userId = this.socketData(client)['userId'];
    if (typeof userId !== 'string' || !userId) {
      throw new WsException('Socket is not authenticated');
    }
    return userId;
  }
}
