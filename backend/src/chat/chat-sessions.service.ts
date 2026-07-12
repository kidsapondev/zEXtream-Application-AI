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
    await this.assertProviderAvailable(dto.defaultProvider);
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
   * registered at runtime. Ollama is deliberately never blocked here (same as
   * before this check existed for claude/openai): a session should still be
   * creatable even if Ollama has a momentary hiccup, with `chat:send` surfacing a
   * clear per-message error if it's genuinely down when the user actually sends —
   * see the equivalent skip in `ChatGateway.onChatSend`. claude/openai now check
   * the host-bridge's live status instead of a per-user API key — see
   * `ProviderSettingsService.isProviderAvailable`.
   */
  private async assertProviderAvailable(
    provider: AiProviderKey,
  ): Promise<void> {
    if (provider === 'ollama') return;
    const available =
      await this.providerSettingsService.isProviderAvailable(provider);
    if (!available) {
      throw new BadRequestException(`${provider} is not currently available`);
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
    const session = await this.getOwned(userId, sessionId);
    // A key could have been removed since the session was created. Re-check
    // when the user changes either part of its runtime selection, while still
    // allowing title/archive updates on historical sessions.
    if (dto.defaultProvider !== undefined || dto.defaultModel !== undefined) {
      await this.assertProviderAvailable(
        dto.defaultProvider ?? session.defaultProvider,
      );
    }
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
