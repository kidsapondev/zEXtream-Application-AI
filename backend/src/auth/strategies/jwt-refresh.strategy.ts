import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}

function extractFromCookie(req: Request): string | null {
  // req.cookies is typed via @types/cookie-parser's index signature, which TS still
  // treats as effectively `any` at the element-access site - narrow explicitly rather
  // than trusting it, matching the same defensive cast auth.controller.ts already uses
  // for this same cookie.
  const token: unknown = req?.cookies?.['refresh_token'];
  return typeof token === 'string' ? token : null;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: extractFromCookie,
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: false,
    });
  }

  validate(payload: RefreshTokenPayload) {
    return { id: payload.sub, tokenId: payload.jti };
  }
}
