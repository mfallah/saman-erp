import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppError } from '@saman/shared';

import { Public } from '../../common/decorators/public.decorator';
import type { HealthService} from './health.service';
import { type BuildInfo, type LivenessReport, type ReadinessReport } from './health.service';

/**
 * Anonymous probes outside the `/api/v1` prefix so infra (compose healthcheck,
 * load balancer, uptime monitor) does not depend on the versioned API surface.
 * Responses still use the standard success/error envelope (`API.md` §1.3).
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('live')
  live(): LivenessReport {
    return this.health.live();
  }

  @Public()
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    if (report.status !== 'ok') {
      const failed = Object.entries(report.checks)
        .filter(([, check]) => check.status === 'down')
        .map(([name, check]) => ({
          rule: name,
          params: { reason: check.reason ?? 'unreachable' },
        }));
      throw new AppError('SERVICE_DEGRADED', { details: failed, retryAfter: 5 });
    }
    return report;
  }

  @Public()
  @Get('version')
  version(): BuildInfo {
    return this.health.version();
  }
}
