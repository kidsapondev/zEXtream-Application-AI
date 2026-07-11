import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { ActiveStreamRegistry } from './active-stream-registry.service';
import { AiProviderKey } from '../ai/ai-provider.interface';
import { ProviderSettingsService } from '../provider-settings/provider-settings.service';

export const DEFAULT_SESSION_TITLE = 'New Chat';

@Injectable()
export class ChatSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly streamRegistry: ActiveStreamRegistry,
    private readonly providerSettingsService: ProviderSettingsService,
  ) {}

  /**
   * `pagination` is optional and, when omitted, this issues the exact same
   * query as before pagination existed (no `take`/`skip` at all) — REST
   * callers that don't pass `limit`/`offset` must see identical results.
   */
  listForUser(userId: string, pagination?: { take: number; skip: number }) {
    return this.prisma.chatSession.findMany({
      where: { userId, isArchived: false },
      orderBy: { updatedAt: 'desc' },
      ...(pagination ? { take: pagination.take, skip: pagination.skip } : {}),
    });
  }

  async create(userId: string, dto: CreateSessionDto) {
    await this.assertProviderConfigured(userId, dto.defaultProvider);
    return this.prisma.chatSession.create({
      data: {
        userId,
        title: dto.title ?? DEFAULT_SESSION_TITLE,
        defaultProvider: dto.defaultProvider,
        defaultModel: dto.defaultModel,
      },
    });
  }

  /**
   * The DTO allowlist (ENABLED_PROVIDERS) only tells us the provider class is
   * registered at runtime — it says nothing about whether *this user* has an
   * API key for it. claude/openai both require one; ollama never does.
   */
  private async assertProviderConfigured(
    userId: string,
    provider: AiProviderKey,
  ): Promise<void> {
    if (provider === 'ollama') return;
    const hasKey = await this.providerSettingsService.hasApiKey(
      userId,
      provider,
    );
    if (!hasKey) {
      throw new BadRequestException(
        `Configure an API key for ${provider} before starting a session with it`,
      );
    }
  }

  async getOwned(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new NotFoundException('Chat session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException(
        'You do not have access to this chat session',
      );
    }
    return session;
  }

  async update(userId: string, sessionId: string, dto: UpdateSessionDto) {
    await this.getOwned(userId, sessionId);
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: dto,
    });
  }

  async remove(userId: string, sessionId: string) {
    await this.getOwned(userId, sessionId);
    // Abort any stream still writing to this session's messages before the
    // session row (and its messages, via cascade) disappears underneath it.
    this.streamRegistry.stopAllForSession(sessionId);
    await this.prisma.chatSession.delete({ where: { id: sessionId } });
  }

  touch(sessionId: string) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });
  }

  /** Sets the session title only if it still has the default placeholder title. */
  async setTitleIfDefault(sessionId: string, title: string): Promise<void> {
    await this.prisma.chatSession.updateMany({
      where: { id: sessionId, title: DEFAULT_SESSION_TITLE },
      data: { title },
    });
  }
}
