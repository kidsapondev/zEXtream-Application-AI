import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request: { user: AuthenticatedUser } = ctx
      .switchToHttp()
      .getRequest();
    return request.user;
  },
);
