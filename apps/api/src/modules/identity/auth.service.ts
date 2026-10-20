import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import { AUDIT, DB, type AuditPort, type Db } from '../../common/contracts';
import type { AuthenticatedActor } from '../../common/auth/authenticated-actor';
import { AppError, PERMISSION_COUNT } from '@saman/shared';

import type { AuthRepository} from './auth.repository';
import { type ActorAccessRecord } from './auth.repository';
import type { AuthRateLimitService } from './auth-rate-limit.service';
import { hashMatches, hashSecret, TokenService, ttlToSeconds } from './token.service';
import { OtpService } from './otp.service';
import type { PasswordService } from './password.service';
import type {
  AuthUserView,
  IssuedAuthTokens,
  LoginChallenge,
  OtpPurpose,
  RequestMeta,
} from './identity.types';
import { toStoredOtpPurpose } from './identity.types';

/** Cookie contract for the auth family (`ADR-0004`, `API.md` §2.2). */
export const REFRESH_COOKIE = 'saman_rt';
export const DEVICE_COOKIE = 'saman_device';
export const AUTH_COOKIE_PATH = '/api/v1/auth';
export const DEVICE_TRUST_DAYS = 30;
export const STEP_UP_TTL_SECONDS = 300;

export interface CookieInstruction {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
}

export interface AuthOutcome {
  readonly status: 200 | 202 | 204;
  readonly body?: Record<string, unknown>;
  readonly setCookies?: readonly CookieInstruction[];
  readonly clearCookies?: readonly string[];
}

export interface AuthRequestContext extends RequestMeta {
  readonly deviceSecret?: string;
  readonly refreshToken?: string;
  readonly userAgentHash?: string;
  readonly ipPrefix?: string;
  /** Mobile supplied by a verified context (self-service OTP purposes). */
  readonly mobileHint?: string;
}

interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly deviceFingerprint?: string;
  readonly deviceName?: string;
}

interface VerifyOtpInput {
  readonly challengeId: string;
  readonly code: string;
  readonly trustDevice?: boolean;
  readonly deviceFingerprint?: string;
  readonly deviceName?: string;
}

const GENERIC_LOGIN_FAILURE = () =>
  new AppError('UNAUTHENTICATED', { messageKey: 'identity.invalid_credentials' });

function addDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function addSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

type UserRecord = NonNullable<Awaited<ReturnType<AuthRepository['findUserById']>>>;
type IssuedSession = IssuedAuthTokens & { readonly refreshToken: string };

/** The outcome shape for refresh rotation and cookie issuance. */
interface RotatePrevious {
  readonly id: bigint;
  readonly userId: bigint;
  readonly familyId: string;
  readonly deviceId: bigint | null;
  readonly mfaVerified: boolean;
  readonly ip: string | null;
  readonly userAgentHash: string | null;
}

/**
 * Authentication & session service (`ADR-0004`, `API.md` §2.2).
 *
 * Two-token model: short-lived HS256 access JWT in memory + opaque refresh token
 * in an httpOnly cookie, rotated on every use with reuse detection. Device trust
 * is proven only by the server-issued 256-bit `deviceSecret` cookie (fingerprints
 * are display labels); a missing/mismatched secret always yields a 202 MFA
 * challenge. OTPs are 6 digits, HMAC-peppered, single-use, attempt-capped.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly tokenService: TokenService;
  private readonly otpService: OtpService;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AUDIT) private readonly audit: AuditPort,
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly rateLimits: AuthRateLimitService,
  ) {
    this.tokenService = new TokenService({
      secret: config.jwtAccessSecret,
      accessTtlSeconds: ttlToSeconds(config.jwtAccessTtl),
    });
    this.otpService = new OtpService(config.otpPepper ?? config.jwtAccessSecret, {
      ttlSeconds: config.otpTtlSeconds,
      maxAttempts: config.otpMaxAttempts,
    });
  }

  get accessTokenTtl(): number {
    return ttlToSeconds(this.config.jwtAccessTtl);
  }

  get refreshTokenTtl(): number {
    return ttlToSeconds(this.config.jwtRefreshTtl);
  }

  get stepUpTtl(): number {
    return STEP_UP_TTL_SECONDS;
  }

  // --- Login ---------------------------------------------------------------

  async login(input: LoginInput, context: AuthRequestContext): Promise<AuthOutcome> {
    await this.enforceRateLimit('auth-login', `${context.ip ?? 'ip'}:${input.username}`, this.config.rateLimitAuthPerMin, 60);
    const organization = await this.repository.loadOrganization();
    const user = await this.repository.findUserByLogin(organization.id, input.username.trim());

    if (user === null || user.passwordHash === null) {
      await this.auditLoginFailure(organization.id, user?.id ?? null, input.username, context, 'bad_credentials');
      throw GENERIC_LOGIN_FAILURE();
    }
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      await this.auditLoginFailure(organization.id, user.id, input.username, context, 'locked');
      throw new AppError('RESOURCE_LOCKED', {
        messageKey: 'identity.account_locked',
        retryAfter: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
      });
    }
    const valid = await this.passwords.verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      const { lockedUntil } = await this.repository.registerFailedLogin(
        user.id,
        this.config.loginMaxFailed,
        this.config.loginLockMinutes,
      );
      await this.auditLoginFailure(organization.id, user.id, input.username, context, 'bad_credentials');
      if (lockedUntil !== null && lockedUntil.getTime() > Date.now()) {
        throw new AppError('RESOURCE_LOCKED', {
          messageKey: 'identity.account_locked',
          retryAfter: this.config.loginLockMinutes * 60,
        });
      }
      throw GENERIC_LOGIN_FAILURE();
    }

    await this.repository.registerSuccessfulLogin(user.id);
    await this.recordLoginAttempt(user.id, user.mobile, input.username, true, null, context);

    const trusted = await this.matchTrustedDevice(user.id, context, input.deviceFingerprint);
    if (!trusted.trusted) {
      const challenge = await this.createOtpChallenge({
        organizationId: organization.id,
        userId: user.id,
        mobile: user.mobile,
        purpose: 'login',
        context,
      });
      await this.auditAction(organization.id, user.id, 'identity.login.mfa_challenged', {
        reason: trusted.reason,
        userAgentHash: context.userAgentHash ?? null,
        requestId: context.requestId,
      });
      return { status: 202, body: { ...challenge } };
    }

    const issued = await this.issueSession(user, {
      deviceId: trusted.deviceId,
      mfaVerified: true,
      authMethod: 'password',
      context,
    });
    await this.auditAction(organization.id, user.id, 'identity.login.succeeded', {
      sessionId: issued.sessionPublicId,
      method: 'password',
      requestId: context.requestId,
    });
    return this.tokensOutcome(issued);
  }

  // --- OTP flows -----------------------------------------------------------

  async requestOtp(
    input: { purpose: string; mobile?: string; challengeId?: string },
    context: AuthRequestContext,
  ): Promise<AuthOutcome> {
    const purpose = toStoredOtpPurpose(input.purpose);
    const organization = await this.repository.loadOrganization();

    if (purpose !== 'login' && purpose !== 'device_trust' && purpose !== 'password_change' && purpose !== 'action_confirm' && purpose !== 'channel_credential') {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'purpose', rule: 'unsupported_otp_purpose' }] });
    }

    // Resend of an existing challenge (login/MFA).
    if (input.challengeId !== undefined) {
      const challenge = await this.repository.findOtpChallenge(input.challengeId);
      if (challenge === null) throw new AppError('NOT_FOUND');
      await this.rateLimitOtp(challenge.mobile);
      const code = this.otpService.generate();
      await this.repository.updateOtpChallenge(challenge.id, {
        codeHash: this.otpService.hash(challenge.mobile, challenge.purpose, code),
        expiresAt: addSeconds(this.otpService.ttlSeconds),
        status: 'pending',
      });
      this.logMockSms(challenge.mobile, code, challenge.purpose);
      return { status: 202, body: { challengeId: challenge.publicId, expiresIn: this.otpService.ttlSeconds, resendAfter: 60 } };
    }

    const mobile = input.mobile ?? context.mobileHint;
    if (mobile === undefined || mobile === '') {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'mobile', rule: 'required' }] });
    }
    await this.rateLimitOtp(mobile);
    const user = await this.repository.findUserByLogin(organization.id, mobile);
    const challenge = await this.createOtpChallenge({
      organizationId: organization.id,
      userId: user?.id ?? null,
      mobile,
      purpose,
      context,
    });
    return { status: 202, body: { ...challenge } };
  }

  async verifyOtp(input: VerifyOtpInput, context: AuthRequestContext): Promise<AuthOutcome> {
    const challenge = await this.repository.findOtpChallenge(input.challengeId);
    if (challenge === null) throw new AppError('NOT_FOUND');
    const now = Date.now();
    if (challenge.status !== 'pending' && challenge.status !== 'verified') {
      throw new AppError(challenge.status === 'consumed' ? 'OTP_INVALID' : 'OTP_EXPIRED');
    }
    if (challenge.expiresAt.getTime() <= now) {
      await this.repository.updateOtpChallenge(challenge.id, { status: 'expired' });
      throw new AppError('OTP_EXPIRED');
    }
    const attempts = await this.repository.incrementOtpAttempt(challenge.id);
    if (attempts > challenge.maxAttempts) {
      await this.repository.updateOtpChallenge(challenge.id, { status: 'locked' });
      throw new AppError('OTP_ATTEMPTS_EXCEEDED');
    }
    const matches = this.otpService.matches(challenge.codeHash, challenge.mobile, challenge.purpose, input.code);
    if (!matches) {
      await this.repository.recordLoginAttempt({
        ipPrefix: context.ipPrefix ?? null,
        username: null,
        mobile: challenge.mobile,
        userId: challenge.userId,
        attemptType: 'otp_verify',
        success: false,
        failureReason: 'otp_invalid',
        userAgentHash: context.userAgentHash ?? null,
      });
      throw new AppError('OTP_INVALID');
    }
    await this.repository.updateOtpChallenge(challenge.id, { status: 'verified', consumed: true });

    const user =
      challenge.userId === null ? null : await this.repository.findUserById(challenge.userId);
    if (user === null) {
      throw new AppError('UNAUTHENTICATED', { messageKey: 'identity.device_untrusted' });
    }

    let deviceId: bigint | null = null;
    let deviceSecret: string | undefined;
    const fingerprint = input.deviceFingerprint ?? null;
    if (input.trustDevice === true && fingerprint !== null) {
      const secret = this.tokenService.generateOpaqueToken();
      const fingerprintHash = hashSecret(fingerprint, this.config.otpPepper ?? this.config.jwtAccessSecret);
      const device = await this.repository.upsertDevice({
        userId: user.id,
        fingerprintHash,
        secretHash: hashSecret(secret, this.config.otpPepper ?? this.config.jwtAccessSecret),
        label: input.deviceName ?? null,
        platform: null,
        userAgentHash: context.userAgentHash ?? null,
        trusted: true,
        trustedUntil: addDays(DEVICE_TRUST_DAYS),
      });
      deviceId = device.id;
      deviceSecret = secret;
    }

    const issued = await this.issueSession(user, {
      deviceId,
      mfaVerified: true,
      authMethod: 'otp',
      context,
    });
    await this.auditAction(user.organizationId, user.id, 'identity.login.succeeded', {
      sessionId: issued.sessionPublicId,
      method: 'otp',
      requestId: context.requestId,
    });
    return this.tokensOutcome(issued, deviceSecret);
  }

  // --- Refresh / logout ----------------------------------------------------

  async refresh(context: AuthRequestContext): Promise<AuthOutcome> {
    const cookie = context.refreshToken;
    if (cookie === undefined || cookie === '') {
      throw new AppError('UNAUTHENTICATED');
    }
    const tokenHash = hashSecret(cookie, this.config.refreshPepper ?? this.config.jwtAccessSecret);
    const session = await this.repository.findSessionByRefreshHash(tokenHash);
    if (session === null) {
      throw new AppError('UNAUTHENTICATED', { messageKey: 'error.session_revoked' });
    }
    if (session.revokedAt !== null) {
      if (session.revokedAt !== null) {
        await this.repository.revokeFamily(session.familyId, 'reuse_detected');
        await this.repository.recordSecurityEvent({
          organizationId: null,
          eventType: 'session.reuse_detected',
          userId: session.userId,
          sessionId: session.id,
          ip: context.ip ?? null,
          userAgentHash: context.userAgentHash ?? null,
          details: { familyId: session.familyId },
          severity: 'critical',
        });
      }
      throw new AppError('REFRESH_TOKEN_REUSED');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.repository.revokeSessionById(session.id, 'expired');
      throw new AppError('SESSION_REVOKED', { messageKey: 'error.session_revoked' });
    }
    const user = await this.repository.findUserById(session.userId);
    if (user === null || user.status === 'inactive') {
      throw new AppError('SESSION_REVOKED');
    }
    return this.rotateAndIssue(session, user, context);
  }

  async logout(actor: AuthenticatedActor, meta: RequestMeta): Promise<AuthOutcome> {
    await this.repository.revokeSessionById(actor.sessionId, 'logout');
    await this.auditAction(actor.orgId, actor.id, 'identity.logout', {
      sessionId: actor.sessionPublicId,
      requestId: meta.requestId,
    });
    return { status: 204, clearCookies: [REFRESH_COOKIE] };
  }

  async logoutAll(actor: AuthenticatedActor, meta: RequestMeta): Promise<AuthOutcome> {
    const revoked = await this.repository.revokeAllSessions(actor.id, 'logout');
    await this.repository.revokeAllDevices(actor.id, null);
    await this.auditAction(actor.orgId, actor.id, 'identity.logout_all', {
      revoked,
      requestId: meta.requestId,
    });
    return { status: 204, clearCookies: [REFRESH_COOKIE, DEVICE_COOKIE] };
  }

  // --- Self profile --------------------------------------------------------

  async me(actor: AuthenticatedActor): Promise<Record<string, unknown>> {
    const user = await this.repository.findUserById(actor.id);
    if (user === null) throw new AppError('UNAUTHENTICATED');
    return this.userView(user, actor);
  }

  permissions(actor: AuthenticatedActor): Record<string, unknown> {
    return { version: PERMISSION_COUNT, keys: actor.permissions };
  }

  // --- Sessions / devices --------------------------------------------------

  async listSessions(actor: AuthenticatedActor): Promise<Record<string, unknown>> {
    const sessions = await this.repository.listSessions(actor.id, actor.sessionId);
    return {
      items: sessions.map((session) => ({
        id: session.publicId,
        deviceLabel: session.deviceLabel,
        ipPrefix: session.ipPrefix,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
        revokedAt: session.revokedAt?.toISOString() ?? null,
        current: session.current,
      })),
    };
  }

  async revokeSession(actor: AuthenticatedActor, publicId: string, meta: RequestMeta): Promise<AuthOutcome> {
    const revoked = await this.repository.revokeSessionByPublicId(actor.id, publicId);
    if (revoked === 0) throw new AppError('NOT_FOUND');
    await this.auditAction(actor.orgId, actor.id, 'identity.session.revoked', {
      target: publicId,
      requestId: meta.requestId,
    });
    return { status: 204 };
  }

  async revokeOtherSessions(actor: AuthenticatedActor, meta: RequestMeta): Promise<AuthOutcome> {
    const revoked = await this.repository.revokeOtherSessions(actor.id, actor.sessionId, 'admin');
    await this.auditAction(actor.orgId, actor.id, 'identity.sessions.revoke_others', {
      revoked,
      requestId: meta.requestId,
    });
    return { status: 204, body: { revokedCount: revoked } };
  }

  async listDevices(actor: AuthenticatedActor): Promise<Record<string, unknown>> {
    const devices = await this.repository.listDevices(actor.id);
    return {
      items: devices.map((device) => ({
        id: device.publicId,
        label: device.label,
        platform: device.platform,
        trusted: device.trusted,
        trustedUntil: device.trustedUntil?.toISOString() ?? null,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      })),
    };
  }

  async forgetDevice(actor: AuthenticatedActor, publicId: string, meta: RequestMeta): Promise<AuthOutcome> {
    const revoked = await this.repository.revokeDevice(actor.id, publicId);
    if (revoked === 0) throw new AppError('NOT_FOUND');
    await this.auditAction(actor.orgId, actor.id, 'identity.device.revoked', {
      target: publicId,
      requestId: meta.requestId,
    });
    return { status: 204 };
  }

  // --- Step-up & password --------------------------------------------------

  async stepUp(
    actor: AuthenticatedActor,
    input: { action: string; password?: string; challengeId?: string; code?: string },
    _meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    await this.enforceRateLimit('auth-step-up', String(actor.id), 10, 900);
    let verified = false;
    if (input.password !== undefined && input.password !== '') {
      const user = await this.repository.findUserById(actor.id);
      verified =
        user?.passwordHash !== null &&
        user?.passwordHash !== undefined &&
        (await this.passwords.verifyPassword(user.passwordHash, input.password));
    } else if (input.challengeId !== undefined && input.code !== undefined) {
      const challenge = await this.repository.findOtpChallenge(input.challengeId);
      if (challenge !== null && challenge.expiresAt.getTime() > Date.now()) {
        const attempts = await this.repository.incrementOtpAttempt(challenge.id);
        verified =
          attempts <= challenge.maxAttempts &&
          this.otpService.matches(challenge.codeHash, challenge.mobile, challenge.purpose, input.code);
        if (verified) {
          await this.repository.updateOtpChallenge(challenge.id, { status: 'verified', consumed: true });
        }
      }
    }
    if (!verified) throw new AppError('STEP_UP_REQUIRED');
    const token = this.tokenService.signStepUpToken({
      sub: actor.publicId,
      sid: actor.sessionPublicId,
      action: input.action,
    });
    return { stepUpToken: token.token, expiresIn: token.expiresIn, action: input.action, sessionId: actor.sessionPublicId };
  }

  async changePassword(
    actor: AuthenticatedActor,
    input: { currentPassword: string; newPassword: string; stepUpToken: string },
    meta: RequestMeta,
  ): Promise<AuthOutcome> {
    this.assertStepUp(input.stepUpToken, actor.sessionPublicId);
    const user = await this.repository.findUserById(actor.id);
    if (user === null || user.passwordHash === null) throw new AppError('UNAUTHENTICATED');
    const currentValid = await this.passwords.verifyPassword(user.passwordHash, input.currentPassword);
    if (!currentValid) throw new AppError('CURRENT_PASSWORD_INVALID');

    const violations = this.passwords.validatePolicy(input.newPassword, {
      username: user.username,
      mobile: user.mobile,
      fullName: user.fullName,
      orgName: this.config.bootstrapOrgName,
    });
    const history = await this.repository.loadPasswordHistory(user.id, 5);
    const reused = await this.passwords.isPasswordReused(input.newPassword, history);
    if (violations.length > 0 || reused) {
      throw new AppError('PASSWORD_POLICY_VIOLATION', {
        details: [
          ...violations.map((rule) => ({ rule })),
          ...(reused ? [{ rule: 'password_reused' }] : []),
        ],
      });
    }
    const passwordHash = await this.passwords.hashPassword(input.newPassword);
    await this.repository.updatePassword(user.id, passwordHash, false);
    await this.repository.revokeOtherSessions(user.id, actor.sessionId, 'password_changed');
    await this.repository.revokeAllDevices(user.id, null);
    await this.repository.recordSecurityEvent({
      organizationId: user.organizationId,
      eventType: 'password.changed',
      userId: user.id,
      sessionId: actor.sessionId,
      ip: meta.ip ?? null,
      userAgentHash: actor.userAgentHash ?? null,
      details: {},
      severity: 'warning',
    });
    await this.auditAction(user.organizationId, user.id, 'identity.password.changed', {
      requestId: meta.requestId,
    });
    return { status: 204 };
  }

  async listSecurityEvents(actor: AuthenticatedActor, limit: number): Promise<Record<string, unknown>> {
    return { items: await this.repository.listSecurityEvents(actor.id, Math.min(limit, 100)) };
  }

  // --- Internals -----------------------------------------------------------

  private async issueSession(
    user: UserRecord,
    options: { deviceId: bigint | null; mfaVerified: boolean; authMethod: 'password' | 'otp'; context: AuthRequestContext },
  ): Promise<IssuedSession> {
    const organization = await this.repository.loadOrganization();
    const access = await this.repository.loadAccess(user.id);
    const refreshToken = this.tokenService.generateOpaqueToken();
    const session = await this.repository.createSession({
      userId: user.id,
      refreshTokenHash: hashSecret(refreshToken, this.config.refreshPepper ?? this.config.jwtAccessSecret),
      deviceId: options.deviceId,
      ipPrefix: options.context.ipPrefix ?? null,
      userAgentHash: options.context.userAgentHash ?? null,
      mfaVerified: options.mfaVerified,
      expiresAt: addSeconds(this.refreshTokenTtl),
      absoluteExpiresAt: addDays(30),
    });
    const accessToken = this.tokenService.signAccessToken({
      sub: user.publicId,
      sid: session.publicId,
      org: organization.publicId,
      pv: user.permissionsVersion,
      mfa: options.mfaVerified,
      amr: [options.authMethod],
      branchIds: (access.branchIds ?? []).map(String),
      warehouseIds: (access.warehouseIds ?? []).map(String),
    });
    return {
      accessToken: accessToken.token,
      expiresIn: accessToken.expiresIn,
      sessionPublicId: session.publicId,
      permissionsVersion: user.permissionsVersion,
      refreshToken,
      user: this.buildUserView(user, access),
    };
  }

  private async rotateAndIssue(
    previous: RotatePrevious,
    user: UserRecord,
    _context: AuthRequestContext,
  ): Promise<AuthOutcome> {
    const organization = await this.repository.loadOrganization();
    const access = await this.repository.loadAccess(user.id);
    const refreshToken = this.tokenService.generateOpaqueToken();
    const session = await this.repository.rotateSession(previous, {
      refreshTokenHash: hashSecret(refreshToken, this.config.refreshPepper ?? this.config.jwtAccessSecret),
      expiresAt: addSeconds(this.refreshTokenTtl),
      absoluteExpiresAt: addDays(30),
    });
    const accessToken = this.tokenService.signAccessToken({
      sub: user.publicId,
      sid: session.publicId,
      org: organization.publicId,
      pv: user.permissionsVersion,
      mfa: previous.mfaVerified,
      amr: ['refresh'],
      branchIds: (access.branchIds ?? []).map(String),
      warehouseIds: (access.warehouseIds ?? []).map(String),
    });
    if (previous.deviceId !== null) await this.repository.touchDevice(previous.deviceId);
    return {
      status: 200,
      body: {
        accessToken: accessToken.token,
        tokenType: 'Bearer',
        expiresIn: accessToken.expiresIn,
        user: this.buildUserView(user, access),
        permissionsVersion: user.permissionsVersion,
        sessionId: session.publicId,
      },
      setCookies: [{ name: REFRESH_COOKIE, value: refreshToken, maxAgeSeconds: this.refreshTokenTtl }],
    };
  }

  private tokensOutcome(tokens: IssuedSession, deviceSecret?: string): AuthOutcome {
    const setCookies: CookieInstruction[] = [
      { name: REFRESH_COOKIE, value: tokens.refreshToken, maxAgeSeconds: this.refreshTokenTtl },
    ];
    if (deviceSecret !== undefined) {
      setCookies.push({ name: DEVICE_COOKIE, value: deviceSecret, maxAgeSeconds: DEVICE_TRUST_DAYS * 86_400 });
    }
    return {
      status: 200,
      body: {
        accessToken: tokens.accessToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        user: tokens.user,
        permissionsVersion: tokens.permissionsVersion,
        sessionId: tokens.sessionPublicId,
      },
      setCookies,
    };
  }

  private buildUserView(
    user: UserRecord,
    access: ActorAccessRecord,
  ): AuthUserView {
    return {
      id: user.publicId,
      fullName: user.fullName,
      mobile: user.mobile,
      email: user.email,
      roles: access.roleCodes,
      permissions: access.permissionKeys,
      scope: {
        branchIds: (access.branchIds ?? []).map(String),
        warehouseIds: (access.warehouseIds ?? []).map(String),
      },
      mfa: user.mfaEnabled,
      permissionsVersion: user.permissionsVersion,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  userView(user: UserRecord, actor: AuthenticatedActor): Record<string, unknown> {
    const view = this.buildUserView(user, {
      permissionKeys: [...actor.permissions],
      roleCodes: [],
      branchIds: actor.branchIds,
      warehouseIds: actor.warehouseIds,
    });
    return { ...view, org: { id: actor.orgPublicId } };
  }

  private async matchTrustedDevice(
    userId: bigint,
    context: AuthRequestContext,
    fingerprint: string | undefined,
  ): Promise<{ trusted: boolean; deviceId: bigint | null; reason: string }> {
    if (fingerprint === undefined || fingerprint === '') {
      return { trusted: false, deviceId: null, reason: 'no_fingerprint' };
    }
    const fingerprintHash = hashSecret(fingerprint, this.config.otpPepper ?? this.config.jwtAccessSecret);
    const device = await this.repository.findDeviceByIdentity(userId, fingerprintHash);
    if (device === null || device.revokedAt !== null) {
      return { trusted: false, deviceId: null, reason: 'device_unknown' };
    }
    if (!device.trusted || device.trustedUntil === null || device.trustedUntil.getTime() <= Date.now()) {
      return { trusted: false, deviceId: device.id, reason: 'device_untrusted' };
    }
    const secret = context.deviceSecret;
    if (secret === undefined || secret === '') {
      return { trusted: false, deviceId: device.id, reason: 'device_secret_missing' };
    }
    const expected = hashSecret(secret, this.config.otpPepper ?? this.config.jwtAccessSecret);
    if (!hashMatches(device.secretHash, expected)) {
      return { trusted: false, deviceId: device.id, reason: 'device_secret_mismatch' };
    }
    await this.repository.touchDevice(device.id);
    return { trusted: true, deviceId: device.id, reason: 'trusted' };
  }

  private async createOtpChallenge(input: {
    organizationId: bigint;
    userId: bigint | null;
    mobile: string;
    purpose: OtpPurpose;
    context: AuthRequestContext;
  }): Promise<LoginChallenge> {
    const code = this.otpService.generate();
    const challenge = await this.repository.createOtpChallenge({
      organizationId: input.organizationId,
      userId: input.userId,
      mobile: input.mobile,
      purpose: input.purpose,
      codeHash: this.otpService.hash(input.mobile, input.purpose, code),
      expiresAt: addSeconds(this.otpService.ttlSeconds),
      maxAttempts: this.otpService.maxAttempts,
      ip: input.context.ip ?? null,
    });
    this.logMockSms(input.mobile, code, input.purpose);
    await this.repository.recordLoginAttempt({
      ipPrefix: input.context.ipPrefix ?? null,
      username: null,
      mobile: input.mobile,
      userId: input.userId,
      attemptType: 'otp_send',
      success: true,
      failureReason: null,
      userAgentHash: input.context.userAgentHash ?? null,
    });
    return {
      mfaRequired: true,
      challengeId: challenge.publicId,
      methods: ['otp_sms'],
      expiresIn: this.otpService.ttlSeconds,
      maskMobile: input.mobile.replace(/(\d{4})\d+(\d{4})/, '$1***$2'),
    };
  }

  private logMockSms(mobile: string, code: string, purpose: OtpPurpose): void {
    if (this.config.smsMode !== 'mock') return;
    // Mock provider: never in production (boot-guard), never log the code at info.
    this.logger.debug({ mobile, purpose, code }, 'sms_otp_mock');
  }

  private async rateLimitOtp(mobile: string): Promise<void> {
    const perHour = await this.rateLimits.consume('auth-otp-request', mobile, this.config.rateLimitOtpPerHour, 3600);
    if (!perHour.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfter: perHour.retryAfter });
    }
    const perTen = await this.rateLimits.consume('auth-otp-request-10m', mobile, 3, 600);
    if (!perTen.allowed) {
      throw new AppError('OTP_RESEND_TOO_SOON', { retryAfter: perTen.retryAfter });
    }
  }

  private async enforceRateLimit(
    bucket: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const result = await this.rateLimits.consume(bucket, identifier, limit, windowSeconds);
    if (!result.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfter: result.retryAfter });
    }
  }

  private assertStepUp(token: string, sessionPublicId: string): void {
    const claims = this.tokenService.verifyStepUpToken(token);
    if (claims.sid !== sessionPublicId) throw new AppError('STEP_UP_REQUIRED');
    // Single-use enforcement is completed via the step-up store in the identity module
    // wiring; the token itself is short-lived (5 min) and bound to (session, action).
  }

  private async recordLoginAttempt(
    userId: bigint,
    mobile: string | null,
    username: string | null,
    success: boolean,
    failureReason: string | null,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.repository.recordLoginAttempt({
      ipPrefix: context.ipPrefix ?? null,
      username,
      mobile,
      userId,
      attemptType: 'password',
      success,
      failureReason,
      userAgentHash: context.userAgentHash ?? null,
    });
  }

  private async auditLoginFailure(
    organizationId: bigint,
    userId: bigint | null,
    username: string,
    context: AuthRequestContext,
    reason: string,
  ): Promise<void> {
    await this.repository.recordLoginAttempt({
      ipPrefix: context.ipPrefix ?? null,
      username,
      mobile: null,
      userId,
      attemptType: 'password',
      success: false,
      failureReason: reason,
      userAgentHash: context.userAgentHash ?? null,
    });
    await this.repository.recordSecurityEvent({
      organizationId,
      eventType: 'login.failure',
      userId,
      sessionId: null,
      ip: context.ip ?? null,
      userAgentHash: context.userAgentHash ?? null,
      details: { reason },
      severity: 'warning',
    });
    await this.auditAction(organizationId, userId, 'identity.login.failed', {
      reason,
      username,
      requestId: context.requestId,
    });
  }

  private async auditAction(
    organizationId: bigint,
    actorId: bigint | null,
    action: string,
    meta: Record<string, unknown> & { requestId: string },
  ): Promise<void> {
    try {
      await this.audit.record(this.db, {
        action,
        entityType: 'identity.user',
        entityId: actorId ?? 0n,
        orgId: organizationId,
        actorId,
        requestId: meta.requestId,
        after: { ...meta },
      });
    } catch (error) {
      // Auditing a login must never block authentication; security_events stay durable.
      this.logger.warn({ err: error instanceof Error ? error.message : 'audit_failed' }, 'audit_write_failed');
    }
  }
}

