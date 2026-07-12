import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics registry for the HTTP surface (see MetricsMiddleware for how
 * requests get recorded, and MetricsController for the scrape endpoint) and the AI
 * streaming pipeline (see ChatGateway.onChatSend, which calls the `*Stream*` methods
 * below at the same points it already touches ActiveStreamRegistry.register()/release()).
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

  private readonly activeStreamsGauge = new Gauge({
    name: 'ai_active_streams',
    help: 'Number of AI chat streams currently in flight, labeled by provider.',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  // Wider/longer-tailed buckets than the HTTP histogram above — a full generation
  // can legitimately run tens of seconds to minutes, unlike a REST request.
  private readonly streamDurationSeconds = new Histogram({
    name: 'ai_stream_duration_seconds',
    help: 'Total duration of an AI chat stream from request to finalization, labeled by provider and final status.',
    labelNames: ['provider', 'status'] as const,
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  private readonly firstTokenLatencySeconds = new Histogram({
    name: 'ai_first_token_latency_seconds',
    help: 'Time from stream start to the first token received from the AI provider, labeled by provider.',
    labelNames: ['provider'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 90],
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

  streamStarted(provider: string): void {
    this.activeStreamsGauge.inc({ provider });
  }

  streamEnded(
    provider: string,
    status: 'complete' | 'error' | 'stopped',
    durationSeconds: number,
  ): void {
    this.activeStreamsGauge.dec({ provider });
    this.streamDurationSeconds.observe({ provider, status }, durationSeconds);
  }

  observeFirstTokenLatency(provider: string, latencySeconds: number): void {
    this.firstTokenLatencySeconds.observe({ provider }, latencySeconds);
  }
}
