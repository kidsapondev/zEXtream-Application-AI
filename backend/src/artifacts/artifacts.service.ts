import { BadRequestException, Injectable } from '@nestjs/common';
import { CodeArtifact, Prisma } from '@prisma/client';
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

  /**
   * Latest revision of every file touched in a session — feeds the file-tabs
   * panel and the AI context builder in `ChatGateway`.
   *
   * Uses `DISTINCT ON (filename) ... ORDER BY filename, revision DESC` so
   * Postgres picks the single newest row per filename directly, instead of
   * pulling every revision of every file into Node just to reduce them in
   * memory (the previous implementation) — same "latest revision per
   * filename" result, but O(files) rows transferred instead of O(revisions).
   * Postgres-specific syntax is fine here: `schema.prisma`'s datasource is
   * `postgresql` only, this app has no other target.
   */
  async listLatestForSession(sessionId: string): Promise<CodeArtifact[]> {
    return this.prisma.$queryRaw<CodeArtifact[]>(Prisma.sql`
      SELECT DISTINCT ON (filename)
        id,
        message_id AS "messageId",
        session_id AS "sessionId",
        filename,
        language,
        content,
        revision,
        parent_artifact_id AS "parentArtifactId",
        origin,
        created_at AS "createdAt"
      FROM code_artifacts
      WHERE session_id = ${sessionId}::uuid
      ORDER BY filename, revision DESC
    `);
  }

  getById(id: string) {
    return this.prisma.codeArtifact.findUnique({ where: { id } });
  }

  /**
   * `pagination` is optional; omitting `limit`/`offset` issues the exact same
   * query as before pagination existed (all revisions, oldest first).
   */
  getRevisions(
    sessionId: string,
    filename: string,
    pagination?: { take: number; skip: number },
  ) {
    const normalizedFilename = normalizeArtifactFilename(filename);
    return this.prisma.codeArtifact.findMany({
      where: { sessionId, filename: normalizedFilename },
      orderBy: { revision: 'asc' },
      ...(pagination ? { take: pagination.take, skip: pagination.skip } : {}),
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
