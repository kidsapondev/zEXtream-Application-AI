import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ArtifactsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Latest revision of every file touched in a session — feeds the file-tabs panel. */
  async listLatestForSession(sessionId: string) {
    const all = await this.prisma.codeArtifact.findMany({
      where: { sessionId },
      orderBy: { revision: 'desc' },
    });
    const latestByFilename = new Map<string, (typeof all)[number]>();
    for (const artifact of all) {
      if (!latestByFilename.has(artifact.filename)) {
        latestByFilename.set(artifact.filename, artifact);
      }
    }
    return [...latestByFilename.values()];
  }

  getById(id: string) {
    return this.prisma.codeArtifact.findUnique({ where: { id } });
  }

  getRevisions(sessionId: string, filename: string) {
    return this.prisma.codeArtifact.findMany({
      where: { sessionId, filename },
      orderBy: { revision: 'asc' },
    });
  }

  async createRevision(params: {
    sessionId: string;
    messageId: string;
    filename: string;
    language: string;
    content: string;
    origin: 'ai' | 'user';
  }) {
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.codeArtifact.findFirst({
        where: { sessionId: params.sessionId, filename: params.filename },
        orderBy: { revision: 'desc' },
      });
      return tx.codeArtifact.create({
        data: {
          sessionId: params.sessionId,
          messageId: params.messageId,
          filename: params.filename,
          language: params.language,
          content: params.content,
          origin: params.origin,
          revision: (latest?.revision ?? 0) + 1,
          parentArtifactId: latest?.id,
        },
      });
    });
  }
}
