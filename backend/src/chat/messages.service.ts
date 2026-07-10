import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiProviderKey } from '../ai/ai-provider.interface';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  listForSession(sessionId: string) {
    return this.prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  createUserMessage(sessionId: string, content: string) {
    return this.prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        content,
        streamingStatus: 'complete',
      },
    });
  }

  createPendingAssistantMessage(sessionId: string, provider: AiProviderKey, model: string) {
    return this.prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        content: '',
        provider,
        model,
        streamingStatus: 'streaming',
      },
    });
  }

  finalizeAssistantMessage(
    messageId: string,
    content: string,
    status: 'complete' | 'error' | 'stopped',
    errorMessage?: string,
  ) {
    return this.prisma.message.update({
      where: { id: messageId },
      data: { content, streamingStatus: status, errorMessage },
    });
  }

  /** Coerces messages stuck mid-stream (e.g. from a server restart) to 'error' on session load. */
  async reconcileStuckMessages(sessionId: string) {
    await this.prisma.message.updateMany({
      where: { sessionId, streamingStatus: 'streaming' },
      data: { streamingStatus: 'error', errorMessage: 'Generation was interrupted.' },
    });
  }
}
