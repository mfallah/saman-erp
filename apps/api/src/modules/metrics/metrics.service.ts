import { Inject, Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus registry and HTTP metrics (`ARCHITECTURE.md` §12).
 * One registry per process; default Node process metrics are prefixed `saman_`
 * so they never collide with a cluster-level collector.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpRequestsTotal: Counter<'method' | 'route' | 'status'>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.registry.setDefaultLabels({ app: 'saman-api', env: config.appEnv });
    if (config.metricsEnabled) {
      collectDefaultMetrics({ register: this.registry, prefix: 'saman_' });
    }
    this.httpRequestDuration = new Histogram({
      name: 'saman_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.httpRequestsTotal = new Counter({
      name: 'saman_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
  }

  observe(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequestDuration.observe(labels, durationSeconds);
    this.httpRequestsTotal.inc(labels);
  }

  /** Prometheus text exposition payload. */
  async render(): Promise<{ body: string; contentType: string }> {
    return { body: await this.registry.metrics(), contentType: this.registry.contentType };
  }
}
