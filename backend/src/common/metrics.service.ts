import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics registry for the HTTP surface (see MetricsMiddleware for how
 * requests get recorded, and MetricsController for the scrape endpoint).
 *
 * Deliberately scoped to what's cleanly reachable from middleware: request rate, error
 * rate (derivable from the `status` label), and request duration. Stream-specific
 * metrics (stream duration, first-token latency, active-stream gauge) need hooks into
 * ActiveStreamRegistry, which lives in the chat module currently being moved by another
 * agent — left as a follow-up rather than bolted on here to avoid touching that file
 * mid-move. Once it lands, a gauge/histogram can be registered on this same `registry`
 * and incremented from there.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests handled, labeled by method, route and status code.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  private readonly httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, labeled by method, route and status code.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  observeHttpRequest(
    method: string,
    route: string,
    status: number,
    durationSeconds: number,
  ): void {
    const labels = { method, route, status: String(status) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDurationSeconds.observe(labels, durationSeconds);
  }
}
