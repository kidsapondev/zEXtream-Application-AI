import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

/**
 * Global pipes/filters registered in main.ts do not apply to `@SubscribeMessage`
 * handlers — NestJS's WS module builds its PipesContextCreator/GuardsContextCreator
 * without the app's ApplicationConfig, so `getGlobalMetadata()` always returns `[]`
 * for gateways (see @nestjs/websockets/socket-module.js#getContextCreator). That is
 * why validation is wired explicitly on ChatGateway via @UsePipes/@UseFilters instead
 * of relying on the REST-side ValidationPipe in main.ts.
 *
 * Without this filter, a failed ValidationPipe check (a BadRequestException, which
 * is an HttpException, not a WsException) falls through to Nest's default WS
 * exception handling as an "unknown" error: the client only sees a generic
 * "Internal server error" and the real validation message is lost. This filter
 * re-wraps HttpExceptions thrown while handling a message as a WsException so
 * they reach the client the same way every other gateway error already does
 * (a client-side `exception` event with a `message`).
 */
@Catch(HttpException)
export class WsValidationFilter extends BaseWsExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = exception.getResponse();
    const rawMessage =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ??
          exception.message);
    const message = Array.isArray(rawMessage)
      ? rawMessage.join(', ')
      : rawMessage;
    super.catch(new WsException(message), host);
  }
}
