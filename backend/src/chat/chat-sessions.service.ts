import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';

@Injectable()
export class ChatSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string) {
    return this.prisma.chatSession.findMany({
      where: { userId, isArchived: false },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateSessionDto) {
    return this.prisma.chatSession.create({
      data: {
        userId,
        title: dto.title ?? 'New Chat',
        defaultProvider: dto.defaultProvider,
        defaultModel: dto.defaultModel,
      },
    });
  }

  async getOwned(userId: string, sessionId: string) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Chat session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this chat session');
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
    await this.prisma.chatSession.delete({ where: { id: sessionId } });
  }

  touch(sessionId: string) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });
  }
}
