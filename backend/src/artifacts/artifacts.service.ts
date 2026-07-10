import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { posix as path } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

/** Maximum UTF-8 size of a single artifact revision (1 MiB). */
export const MAX_ARTIFACT_CONTENT_BYTES = 1024 * 1024;

/** Maximum UTF-8 size of an artifact's normalized relative path. */
export const MAX_ARTIFACT_FILENAME_BYTES = 255;

/** Limits database growth from a single model response or repeated user edits. */
export const MAX_ARTIFACT_REVISIONS_PER_MESSAGE = 50;
export const MAX_ARTIFACT_REVISIONS_PER_SESSION = 1000;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function assertArtifactContentBytes(byteLength: number): void {
  if (byteLength > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new BadRequestException(
      `Artifact content must not exceed ${MAX_ARTIFACT_CONTENT_BYTES} bytes`,
    );
  }
}

/**
 * Converts a model- or user-supplied file path to a safe, portable relative
 * path. Artifact names are not written to disk today, but keeping this boundary
 * strict means they cannot become traversal paths when files are exported later.
 */
export function normalizeArtifactFilename(filename: unknown): string {
  if (typeof filename !== 'string') {
    throw new BadRequestException('Artifact filename must be a string');
  }

  const candidate = filename.trim().replaceAll('\\', '/');
  if (!candidate) {
    throw new BadRequestException('Artifact filename is required');
  }
  if (containsControlCharacter(candidate)) {
    throw new BadRequestException(
      'Artifact filename contains invalid characters',
    );
  }
  if (/^[a-zA-Z]:/.test(candidate) || candidate.startsWith('/')) {
    throw new BadRequestException('Artifact filename must be a relative path');
  }

  const parts = candidate.split('/');
  if (parts.at(-1) === '') {
    throw new BadRequestException('Artifact filename must name a file');
  }
  if (parts.some((part) => part === '..')) {
    throw new BadRequestException(
      'Artifact filename must not contain parent paths',
    );
  }

  const normalized = path.normalize(candidate);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    throw new BadRequestException('Artifact filename must be a relative path');
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_ARTIFACT_FILENAME_BYTES) {
    throw new BadRequestException(
      `Artifact filename must not exceed ${MAX_ARTIFACT_FILENAME_BYTES} bytes`,
    );
  }

  return normalized;
}

export function assertArtifactContent(
  content: unknown,
): asserts content is string {
  if (typeof content !== 'string') {
    throw new BadRequestException('Artifact content must be a string');
  }
  assertArtifactContentBytes(Buffer.byteLength(content, 'utf8'));
}

export function assertArtifactRevisionQuota(
  messageCount: number,
  sessionCount: number,
): void {
  if (messageCount >= MAX_ARTIFACT_REVISIONS_PER_MESSAGE) {
    throw new BadRequestException(
      `A message may contain at most ${MAX_ARTIFACT_REVISIONS_PER_MESSAGE} artifact revisions`,
    );
  }
  if (sessionCount >= MAX_ARTIFACT_REVISIONS_PER_SESSION) {
    throw new BadRequestException(
      `A session may contain at most ${MAX_ARTIFACT_REVISIONS_PER_SESSION} artifact revisions`,
    );
  }
}

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
    const normalizedFilename = normalizeArtifactFilename(filename);
    return this.prisma.codeArtifact.findMany({
      where: { sessionId, filename: normalizedFilename },
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
    const filename = normalizeArtifactFilename(params.filename);
    assertArtifactContent(params.content);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const [messageCount, sessionCount] = await Promise.all([
            tx.codeArtifact.count({ where: { messageId: params.messageId } }),
            tx.codeArtifact.count({ where: { sessionId: params.sessionId } }),
          ]);
          assertArtifactRevisionQuota(messageCount, sessionCount);

          const latest = await tx.codeArtifact.findFirst({
            where: { sessionId: params.sessionId, filename },
            orderBy: { revision: 'desc' },
          });
          return tx.codeArtifact.create({
            data: {
              sessionId: params.sessionId,
              messageId: params.messageId,
              filename,
              language: params.language,
              content: params.content,
              origin: params.origin,
              revision: (latest?.revision ?? 0) + 1,
              parentArtifactId: latest?.id,
            },
          });
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002' ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }

    throw new Error('Could not create artifact revision');
  }
}
