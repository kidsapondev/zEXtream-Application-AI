import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

export interface TokenRequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function parseDurationMs(duration: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration string: ${duration}`);
  }
  const value = Number(match[1]);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * unitMs[match[2]];
}

// jsonwebtoken's SignOptions types `expiresIn` as a template-literal-narrowed `ms.StringValue`
// rather than `string`; our durations are always validated at startup by env.validation.ts,
// so this cast just satisfies an overly-strict third-party type, not a real safety gap.
function asJwtExpiry(duration: string) {
  return duration as unknown as `${number}${'s' | 'm' | 'h' | 'd'}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresIn: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessSecret = this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessExpiresIn = this.configService.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    this.refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
  }

  async validateCredentials(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.isActive) {
      return null;
    }
    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      return null;
    }
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  async register(data: { email: string; password: string; displayName: string }, meta: TokenRequestMeta) {
    const existing = await this.usersService.findByEmail(data.email);
    if (existing) {
      throw new UnauthorizedException('An account with this email already exists');
    }
    const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id });
    const user = await this.usersService.create({
      email: data.email,
      passwordHash,
      displayName: data.displayName,
    });
    const tokens = await this.issueTokenPair(user.id, user.email, meta);
    return { user: { id: user.id, email: user.email, displayName: user.displayName }, tokens };
  }

  async login(user: { id: string; email: string; displayName: string }, meta: TokenRequestMeta) {
    const tokens = await this.issueTokenPair(user.id, user.email, meta);
    return { user, tokens };
  }

  async refresh(userId: string, tokenId: string, meta: TokenRequestMeta): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({ where: { id: tokenId } });

    if (!row || row.userId !== userId) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (row.revokedAt) {
      // A revoked token being presented again means it was already rotated once before —
      // this is the reuse-detection signal for token theft. Nuke the whole rotation chain.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected, all sessions revoked');
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.usersService.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer active');
    }

    const { tokens, newRowId } = await this.issueTokenPairInternal(user.id, user.email, meta, row.familyId);

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date(), replacedById: newRowId },
    });

    return tokens;
  }

  async logout(tokenId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { id: tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokenPair(userId: string, email: string, meta: TokenRequestMeta): Promise<TokenPair> {
    const { tokens } = await this.issueTokenPairInternal(userId, email, meta, randomUUID());
    return tokens;
  }

  private async issueTokenPairInternal(
    userId: string,
    email: string,
    meta: TokenRequestMeta,
    familyId: string,
  ): Promise<{ tokens: TokenPair; newRowId: string }> {
    const expiresAt = new Date(Date.now() + parseDurationMs(this.refreshExpiresIn));

    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: '',
        familyId,
        expiresAt,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
      },
    });

    const refreshToken = this.jwtService.sign(
      { sub: userId, jti: row.id },
      { secret: this.refreshSecret, expiresIn: asJwtExpiry(this.refreshExpiresIn) },
    );

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { tokenHash: hashToken(refreshToken) },
    });

    const accessToken = this.jwtService.sign(
      { sub: userId, email },
      { secret: this.accessSecret, expiresIn: asJwtExpiry(this.accessExpiresIn) },
    );

    return { tokens: { accessToken, refreshToken }, newRowId: row.id };
  }

  getRefreshCookieMaxAgeMs(): number {
    return parseDurationMs(this.refreshExpiresIn);
  }
}
