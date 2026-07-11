import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      // req.route.path is only populated once Express has matched a route, and is
      // already parameterized (e.g. "/chat/sessions/:id") rather than the literal path
      // — falling back to req.path for unmatched routes (404s) means those all collapse
      // under whatever the raw path happened to be, which is an acceptable amount of
      // cardinality for an app with a small, fixed route table. Typed explicitly since
      // @types/express resolves req.route as `any` in this codebase's setup.
      const matchedRoute = req.route as { path?: string } | undefined;
      const route: string = matchedRoute?.path ?? req.path;
      this.metrics.observeHttpRequest(
        req.method,
        route,
        res.statusCode,
        durationSeconds,
      );
    });
    next();
  }
}
