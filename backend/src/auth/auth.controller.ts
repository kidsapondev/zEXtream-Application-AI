import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { Public } from './decorators/public.decorator';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

const REFRESH_COOKIE_NAME = 'refresh_token';
// Scoped to /api/auth (not just /api/auth/refresh) — logout also needs to read this
// cookie to know which refresh-token row to revoke, and cookie path matching only
// covers exact/prefix matches, so a narrower scope would silently exclude it.
const REFRESH_COOKIE_PATH = '/api/auth';

// These endpoints are @Public() (no JWT required), so the global ThrottlerGuard's
// default limit (100 req/min, see app.module.ts) is the only thing standing between
// them and brute-force/credential-stuffing/mass-registration abuse — tighten per-route.
const LOGIN_THROTTLE = { default: { limit: 5, ttl: 60_000 } };
const REGISTER_THROTTLE = { default: { limit: 3, ttl: 60_000 } };
// Higher than login/register: the SPA can fire a refresh call from every open tab the
// moment the access token expires (see frontend auth.store.ts/auth.interceptor.ts —
// each tab dedupes its own concurrent calls but tabs don't coordinate with each other),
// and all tabs share the same refresh cookie/IP. 20/min comfortably covers a handful of
// tabs refreshing in the same burst without opening the door to brute-forcing tokens.
const REFRESH_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private setRefreshCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: this.authService.getRefreshCookieMaxAgeMs(),
    });
  }

  private requestMeta(req: Request) {
    return {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    };
  }

  private refreshTokenFromRequest(req: Request): string {
    const token: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token !== 'string' || !token) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return token;
  }

  @Public()
  @Throttle(REGISTER_THROTTLE)
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, tokens } = await this.authService.register(
      dto,
      this.requestMeta(req),
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    return { user, accessToken: tokens.accessToken };
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @UseGuards(LocalAuthGuard)
  @Post('login')
  async login(
    @Req() req: Request,
    @Body() _dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as {
      id: string;
      email: string;
      displayName: string;
      role: string;
    };
    const { tokens } = await this.authService.login(
      user,
      this.requestMeta(req),
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    return { user, accessToken: tokens.accessToken };
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { id, tokenId } = req.user as { id: string; tokenId: string };
    const tokens = await this.authService.refresh(
      id,
      tokenId,
      this.refreshTokenFromRequest(req),
      this.requestMeta(req),
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { id, tokenId } = req.user as { id: string; tokenId: string };
    await this.authService.logout(id, tokenId);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return { success: true };
  }
}
