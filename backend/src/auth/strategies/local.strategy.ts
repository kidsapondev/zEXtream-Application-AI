import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import type { Request } from 'express';
import { AuthService } from '../auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly authService: AuthService) {
    // passReqToCallback so validate() can read the request IP — needed to attach an
    // IP address to the auth.login.failure audit log entry (see auth.service.ts).
    super({ usernameField: 'email', passReqToCallback: true });
  }

  async validate(req: Request, email: string, password: string) {
    const user = await this.authService.validateCredentials(email, password, {
      ipAddress: req.ip,
    });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return user;
  }
}
