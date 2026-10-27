import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { STEP_UP_METADATA_KEY } from '../decorators/require-step-up.decorator';
import { isSensitivePermission, sensitivePermissions } from './step-up-policy';

export interface StepUpCoverageGap {
  readonly method: string;
  readonly path: string;
  readonly permissions: readonly string[];
}

function asPaths(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/** `/accounting/journal-entries/:id/post` from the controller + handler metadata. */
function routePath(controllerPath: unknown, handlerPath: unknown): string {
  const segments = [...asPaths(controllerPath), ...asPaths(handlerPath)].filter(
    (segment) => segment !== '' && segment !== '/',
  );
  return `/${segments.join('/')}`.replace(/\/{2,}/g, '/');
}

/** Reads method-level metadata first, then the controller-level fallback. */
function inheritedMetadata<T>(key: string, handler: object, controller: object): T | undefined {
  const own = Reflect.getMetadata(key, handler) as T | undefined;
  return own ?? (Reflect.getMetadata(key, controller) as T | undefined);
}

/**
 * TD-16 startup self-check.
 *
 * Enumerates every mounted controller route, reads `@Permissions(...)` and
 * `@RequireStepUp(...)`, and logs one warning that lists every route whose
 * permissions fall inside the sensitive step-up matrix but that has no
 * step-up metadata. This makes new sensitive endpoints (and accidental
 * decorator removal) visible at boot instead of silently trusting the guard
 * to be applied.
 */
@Injectable()
export class StepUpCoverageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StepUpCoverageService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const gaps = this.collectGaps();
    if (gaps.length === 0) {
      this.logger.log('step_up_coverage_check_passed uncovered=0');
      return;
    }
    const listing = gaps.map(
      (gap) => `${gap.method} ${gap.path} [${gap.permissions.join(', ')}]`,
    );
    this.logger.warn(
      {
        uncovered: gaps.length,
        routes: gaps,
      },
      `step_up_coverage_gap: ${gaps.length} sensitive route(s) lack @RequireStepUp: ${listing.join(' | ')}`,
    );
  }

  /** Pure route scan (also used by the self-check test). */
  collectGaps(): StepUpCoverageGap[] {
    const gaps: StepUpCoverageGap[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (instance === null || instance === undefined) continue;
      if (metatype === null || metatype === undefined) continue;
      const prototype = metatype.prototype as object;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype);

      for (const methodKey of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[methodKey];
        if (typeof handler !== 'function') continue;
        const requestMethod = inheritedMetadata<RequestMethod>(
          METHOD_METADATA,
          handler,
          metatype,
        );
        if (requestMethod === undefined) continue;

        const permissions =
          inheritedMetadata<readonly string[]>(PERMISSIONS_KEY, handler, metatype) ?? [];
        if (sensitivePermissions(permissions).length === 0) continue;

        const stepUp = inheritedMetadata<string>(STEP_UP_METADATA_KEY, handler, metatype);
        if (stepUp !== undefined) continue;

        gaps.push({
          method: RequestMethod[requestMethod] ?? String(requestMethod),
          path: routePath(controllerPath, Reflect.getMetadata(PATH_METADATA, handler)),
          permissions: permissions.filter(isSensitivePermission),
        });
      }
    }
    return gaps.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  }
}
