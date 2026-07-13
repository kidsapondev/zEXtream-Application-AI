import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

/** Maximum UTF-8 size of a single memory note — these are meant to be short,
 * durable facts ("prefers dark mode", "works in Bangkok"), not paragraphs. */
export const MAX_MEMORY_NOTE_BYTES = 2 * 1024;

/** Caps unbounded DB growth: once a user has this many notes, the oldest are
 * evicted to make room for new ones on the next extraction. */
export const MAX_MEMORY_NOTES_PER_USER = 200;

/** How many of a user's most recent notes are injected into the system prompt
 * on every chat turn — bounded so memory can't unboundedly grow the prompt. */
export const MEMORY_NOTES_INJECTED = 30;

/** Generous, mirroring OLLAMA_CONNECT_TIMEOUT_MS's reasoning (see
 * ollama.provider.ts): a cold model load alone can take several seconds
 * before Ollama responds at all. Extraction runs fire-and-forget in the
 * background (see extractFromExchange), so there's no user-facing latency
 * cost to waiting out a slow cold load rather than abandoning it. */
const EXTRACTION_TIMEOUT_MS = 60_000;

/** Extraction returns at most this many new facts per exchange — a single
 * short exchange legitimately yielding more than this is a sign the model
 * misunderstood the "durable facts only" instruction, not real signal. */
const MAX_FACTS_PER_EXTRACTION = 10;

// Asking for a bare JSON array (rather than an object) is unreliable in
// practice — confirmed by hand against a real local model, which returned an
// arbitrary flat object of its own invented keys (e.g. {"location":
// "Bangkok"}) instead of the requested array shape. Wrapping the expected
// shape in a named object property is a well-known trick for getting
// structured-output models to comply, and did in testing — parseFacts()
// still tolerates the flat-object shape as a fallback in case another model
// reverts to it.
const EXTRACTION_SYSTEM_PROMPT = `You extract durable, long-term facts and preferences about a user from a single chat exchange — the kind of thing worth remembering across unrelated future conversations (their name, role, location, stated preferences, ongoing projects). Do not include one-off task details, code, or anything specific only to this exchange. Respond with ONLY a JSON object of this exact shape: {"facts": ["Works as a data scientist", "Prefers dark mode"]}. Each entry must be a short, self-contained sentence. If there is nothing durable to remember, respond with {"facts": []}.`;

interface OllamaGenerateResponse {
  response?: string;
}

/**
 * Backs Phase 11 ("chat memory"): after each finished exchange, a small Ollama
 * model extracts durable facts about the user and stores them here; future
 * chat turns (any provider) get the user's notes injected into the system
 * prompt. See chat.gateway.ts for both call sites.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  list(userId: string) {
    return this.prisma.userMemoryNote.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.userMemoryNote.deleteMany({
      where: { id, userId },
    });
    if (count === 0) {
      throw new NotFoundException('Memory note not found');
    }
  }

  async removeAll(userId: string): Promise<void> {
    await this.prisma.userMemoryNote.deleteMany({ where: { userId } });
  }

  /**
   * Notes to inject into a new chat turn's system prompt, oldest-first (so
   * they read like a settled list of facts, not a most-recent-first log) —
   * `null` when the user has nothing remembered yet, so callers can skip
   * adding an empty/noisy system message.
   */
  async notesForPrompt(userId: string): Promise<string[] | null> {
    const notes = await this.prisma.userMemoryNote.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: MEMORY_NOTES_INJECTED,
      select: { content: true },
    });
    if (notes.length === 0) return null;
    return notes.map((n) => n.content).reverse();
  }

  /**
   * Fire-and-forget from the caller's point of view: extracts durable facts
   * from one exchange via Ollama and upserts them. Never throws — a failure
   * here (Ollama unreachable, malformed output, etc.) must never surface to
   * the chat response that already completed.
   */
  async extractFromExchange(
    userId: string,
    sessionId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const model = this.configService.get<string>('MEMORY_EXTRACTION_MODEL');
    if (!model) return;

    try {
      const facts = await this.runExtraction(model, userContent, assistantContent);
      for (const fact of facts.slice(0, MAX_FACTS_PER_EXTRACTION)) {
        await this.upsertNote(userId, sessionId, fact);
      }
    } catch (error) {
      this.logger.warn(
        `Memory extraction failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async runExtraction(
    model: string,
    userContent: string,
    assistantContent: string,
  ): Promise<string[]> {
    const baseUrl = this.configService.get<string>('OLLAMA_BASE_URL');
    if (!baseUrl) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          format: 'json',
          stream: false,
          prompt: `${EXTRACTION_SYSTEM_PROMPT}\n\nUser: ${userContent}\nAssistant: ${assistantContent}`,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const body = (await response.json()) as OllamaGenerateResponse;
      return parseFacts(body.response);
    } finally {
      clearTimeout(timer);
    }
  }

  private async upsertNote(
    userId: string,
    sessionId: string,
    content: string,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_MEMORY_NOTE_BYTES) return;

    const existing = await this.prisma.userMemoryNote.findFirst({
      where: {
        userId,
        content: { equals: trimmed, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.userMemoryNote.create({
      data: { userId, content: trimmed, sourceSessionId: sessionId },
    });
    await this.evictOverflow(userId);
  }

  private async evictOverflow(userId: string): Promise<void> {
    const total = await this.prisma.userMemoryNote.count({ where: { userId } });
    const overflow = total - MAX_MEMORY_NOTES_PER_USER;
    if (overflow <= 0) return;

    const oldest = await this.prisma.userMemoryNote.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: overflow,
      select: { id: true },
    });
    await this.prisma.userMemoryNote.deleteMany({
      where: { id: { in: oldest.map((n) => n.id) } },
    });
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Ollama's `format: 'json'` guarantees syntactically valid JSON, but not that
 * it matches the requested `{"facts": [...]}` shape. Handles, in order: the
 * requested shape; a bare array (some models ignore the wrapper instruction);
 * and a flat object of invented keys (confirmed by hand against a real local
 * model, which returned `{"location": "Bangkok", ...}` instead of the asked-for
 * shape) by treating its string values as the facts. Anything else — `{}`, a
 * single string, non-string array entries — normalizes to `[]` rather than throw. */
function parseFacts(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (isStringArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (isStringArray(obj.facts)) return obj.facts;
    return Object.values(obj).filter(
      (value): value is string => typeof value === 'string',
    );
  }
  return [];
}
