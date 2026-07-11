import {
  Controller,
  Get,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Separate from AppController's GET /api/health (liveness — "is the process up",
 * checked by container orchestration to decide whether to restart the container).
 *
 * GET /api/health/ready is readiness — "can this instance actually serve traffic" —
 * which additionally pings Postgres. A load balancer/orchestrator should stop routing
 * traffic to an instance that fails this without necessarily restarting it (the
 * database being temporarily unreachable isn't this process's fault).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        status: 'error',
        database: 'unreachable',
      });
    }
  }
}
