import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@saman/shared';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { AuthenticatedOnly } from '../../common/decorators/authenticated-only.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { getRequestId } from '../../common/request-id/request-id';
import type { AuthenticatedActor } from '../../common/auth/authenticated-actor';
import type { RequestWithContext } from '../../common/decorators/current-context.decorator';
import { AuthService } from './auth.service';
import { AUTH_COOKIE_PATH, DEVICE_COOKIE, REFRESH_COOKIE, type AuthOutcome, type AuthRequestContext } from './auth.service';

const loginSchema = z.object({
  username: z.string().min(3).max(100),
  password: z.string().min(1).max(256),
  deviceFingerprint: z.string().max(256).optional(),
  deviceName: z.string().max(150).optional(),
});
const otpRequestSchema = z.object({
  purpose: z.enum(['login', 'mfa', 'step_up', 'password_change', 'password_reset', 'device_trust', 'channel_credential']),
  mobile: z.string().min(10).max(20).optional(),
  challengeId: z.string().uuid().optional(),
  captchaToken: z.string().max(2048).optional(),
});
const loginOtpSchema = otpRequestSchema.omit({ purpose: true });
const mfaResendSchema = z.object({ challengeId: z.string().uuid() });
const otpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  trustDevice: z.boolean().optional(),
  deviceFingerprint: z.string().max(256).optional(),
  deviceName: z.string().max(150).optional(),
});
const stepUpSchema = z.object({
  action: z.string().min(3).max(120),
  sessionId: z.string().uuid().optional(),
  password: z.string().max(256).optional(),
  challengeId: z.string().uuid().optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
  stepUpToken: z.string().min(20),
});

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', {
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), code: issue.code })),
    });
  }
  return parsed.data;
}

function hashUserAgent(userAgent: string | undefined): string | undefined {
  return userAgent === undefined ? undefined : createHash('sha256').update(userAgent).digest('hex');
}

function ipPrefix(ip: string | undefined): string | undefined {
  if (ip === undefined) return undefined;
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  // IPv6: keep the first 4 groups (≈/64) for privacy.
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  return undefined;
}

function requestContext(request: FastifyRequest): AuthRequestContext {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies ?? {};
  const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;
  return {
    requestId: getRequestId(request),
    ip: request.ip,
    ...(userAgent === undefined ? {} : { userAgent, userAgentHash: hashUserAgent(userAgent) }),
    ipPrefix: ipPrefix(request.ip),
    ...(cookies[DEVICE_COOKIE] === undefined ? {} : { deviceSecret: cookies[DEVICE_COOKIE] }),
    ...(cookies[REFRESH_COOKIE] === undefined ? {} : { refreshToken: cookies[REFRESH_COOKIE] }),
  };
}

/**
 * `/api/v1/auth/*` endpoints (`API.md` §2.2). Tokens never touch localStorage:
 * the refresh token and device secret are httpOnly cookies scoped to the auth path.
 */
@AuthenticatedOnly()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('config')
  configInfo(): Record<string, unknown> {
    return {
      passwordLogin: true,
      otpLogin: true,
      mfaPolicy: 'untrusted_devices',
      orgName: this.config.bootstrapOrgName,
      smsMode: this.config.smsMode === 'limo' ? 'real' : 'mock',
      policy: { minLength: 12 },
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(loginSchema, body);
    const outcome = await this.auth.login(input, requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(otpRequestSchema, body);
    const outcome = await this.auth.requestOtp(input, requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('login/otp')
  @HttpCode(202)
  async requestLoginOtp(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(loginOtpSchema, body);
    const outcome = await this.auth.requestOtp({ ...input, purpose: 'login' }, requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('mfa/resend')
  @HttpCode(202)
  async resendMfa(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(mfaResendSchema, body);
    const outcome = await this.auth.requestOtp(
      { challengeId: input.challengeId, purpose: 'mfa' },
      requestContext(request),
    );
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(otpVerifySchema, body);
    const outcome = await this.auth.verifyOtp(input, requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(otpVerifySchema, body);
    const outcome = await this.auth.verifyOtp(input, requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const outcome = await this.auth.refresh(requestContext(request));
    return this.applyOutcome(outcome, reply);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.applyOutcome(await this.auth.logout(this.actor(request), this.meta(request)), reply);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.applyOutcome(await this.auth.logoutAll(this.actor(request), this.meta(request)), reply);
  }

  @Get('me')
  me(@Req() request: FastifyRequest): Promise<Record<string, unknown>> {
    return this.auth.me(this.actor(request));
  }

  @Get('permissions')
  permissions(@Req() request: FastifyRequest): Record<string, unknown> {
    return this.auth.permissions(this.actor(request));
  }

  @Get('sessions')
  sessions(@Req() request: FastifyRequest): Promise<Array<Record<string, unknown>>> {
    return this.auth.listSessions(this.actor(request));
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.auth.revokeSession(this.actor(request), id, this.meta(request));
  }

  @Post('sessions/revoke-others')
  @HttpCode(204)
  async revokeOthers(@Req() request: FastifyRequest) {
    await this.auth.revokeOtherSessions(this.actor(request), this.meta(request));
  }

  @Get('devices')
  devices(@Req() request: FastifyRequest): Promise<Record<string, unknown>> {
    return this.auth.listDevices(this.actor(request));
  }

  @Delete('devices/:id')
  @HttpCode(204)
  async forgetDevice(@Param('id') id: string, @Req() request: FastifyRequest) {
    await this.auth.forgetDevice(this.actor(request), id, this.meta(request));
  }

  @Get('security-events')
  securityEvents(@Req() request: FastifyRequest, @Query('limit') limit?: string): Promise<Record<string, unknown>> {
    const parsed = Number(limit ?? '20');
    return this.auth.listSecurityEvents(this.actor(request), Number.isFinite(parsed) ? parsed : 20);
  }

  @Post('step-up')
  @HttpCode(200)
  stepUp(@Body() body: unknown, @Req() request: FastifyRequest): Promise<Record<string, unknown>> {
    const input = parse(stepUpSchema, body);
    return this.auth.stepUp(this.actor(request), input, this.meta(request));
  }

  @Post('password/change')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(changePasswordSchema, body);
    await this.auth.changePassword(this.actor(request), input, this.meta(request));
  }

  private actor(request: FastifyRequest): AuthenticatedActor {
    const actor = (request as RequestWithContext).user;
    if (actor === undefined) throw new AppError('UNAUTHENTICATED');
    return actor;
  }

  private meta(request: FastifyRequest): { requestId: string; ip?: string; userAgent?: string } {
    const userAgent = typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined;
    return {
      requestId: getRequestId(request),
      ...(request.ip === undefined ? {} : { ip: request.ip }),
      ...(userAgent === undefined ? {} : { userAgent }),
    };
  }

  private applyOutcome(outcome: AuthOutcome, reply: FastifyReply): Record<string, unknown> | undefined {
    for (const cookie of outcome.setCookies ?? []) {
      reply.setCookie(cookie.name, cookie.value, {
        path: AUTH_COOKIE_PATH,
        httpOnly: true,
        secure: this.config.cookieSecure,
        sameSite: 'lax',
        maxAge: cookie.maxAgeSeconds,
      });
    }
    for (const cookieName of outcome.clearCookies ?? []) {
      reply.clearCookie(cookieName, { path: AUTH_COOKIE_PATH });
    }
    reply.status(outcome.status);
    return outcome.body;
  }
}
