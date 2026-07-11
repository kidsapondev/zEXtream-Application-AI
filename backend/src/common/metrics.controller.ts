import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

// Exposed at GET /api/metrics (global prefix applies, same as every other route).
// Intentionally @Public(): Nest has no built-in IP-allowlisting primitive, and the
// payload is Prometheus-format counters/histograms with no secrets in it, so app-level
// auth isn't the right control here — operators should restrict scrape access at the
// network/reverse-proxy layer (e.g. don't expose /api/metrics through the public nginx
// vhost; scrape it from inside the docker network instead) rather than gating it with a
// bearer token that a scraper config would then need to carry.
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  async getMetrics(@Res() res: Response): Promise<void> {
    res.set('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
