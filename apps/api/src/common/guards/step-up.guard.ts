import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '@saman/shared';
import type { FastifyRequest } from 'fastify';

import type { AuthenticatedActor } from '../auth/authenticated-actor';
import { STEP_UP_METADATA_KEY } from '../decorators/require-step-up.decorator';
import { TokenService } from '../../modules/identity/token.service';
import { APP_CONFIG } from '../../config/env.schema';
import type { AppConfig } from '../../config/env.schema';

/** Step-up proofs are short-lived by design; older tokens are rejected. */
export const STEP_UP_MAX_AGE_SECONDS = 300;

/**
 * Fail-closed step-up enforcement for sensitive routes (`SECURITY.md` §4):
 * - the proof must be a valid `step_up` JWT signed by this service,
 * - it must belong to the caller (`sub`) and the current session (`sid`),
 * - its action (`act`) must equal the route's required action,
 * - it must be at most five minutes old.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  private readonly tokens: TokenService;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.tokens = new TokenService({ secret: config.jwtAccessSecret, accessTtlSeconds: 600 });
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string | undefined>(STEP_UP_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedActor }>();
    const actor = request.user;
    if (actor === undefined) throw new AppError('UNAUTHENTICATED');

    const raw = request.headers['x-step-up-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (token === undefined || token.length < 20) {
      throw new AppError('STEP_UP_REQUIRED', {
        message: 'برای این عملیات حساس، تأیید هویت مجدد لازم است.',
        messageKey: 'identity.step_up_required',
      });
    }

    let claims;
    try {
      claims = this.tokens.verifyStepUpToken(token);
    } catch {
      throw new AppError('STEP_UP_REQUIRED', {
        message: 'کد تأیید عملیات منقضی یا نامعتبر است.',
        messageKey: 'identity.step_up_invalid',
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const fresh = now - claims.iat <= STEP_UP_MAX_AGE_SECONDS;
    const bound = claims.sub === actor.publicId && claims.sid === actor.sessionPublicId;
    const actionMatches = claims.act === required;
    if (!fresh || !bound || !actionMatches) {
      throw new AppError('STEP_UP_REQUIRED', {
        message: 'تأیید هویت مجدد برای این عملیات معتبر نیست.',
        messageKey: 'identity.step_up_invalid',
      });
    }

    return true;
  }
}
