import { AppError } from '@saman/shared';

/** Internal identity row/actor shapes (repository <-> service boundary). */
export interface IdentityUserRecord {
  readonly id: bigint;
  readonly publicId: string;
  readonly organizationId: bigint;
  readonly username: string;
  readonly mobile: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly passwordHash: string | null;
  readonly status: 'active' | 'inactive' | 'locked' | 'password_reset_required';
  readonly mustChangePassword: boolean;
  readonly permissionsVersion: number;
  readonly mfaEnabled: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly locale: string;
  readonly lastLoginAt: Date | null;
}

export interface AttachmentFields {
  readonly ip?: string;
  readonly ipPrefix?: string;
  readonly userAgentHash?: string;
  readonly requestId: string;
}

export interface RequestMeta {
  readonly ip?: string;
  readonly userAgent?: string;
  readonly requestId: string;
}

/** Token response payload returned to the SPA (refresh/device secrets stay in cookies). */
export interface IssuedAuthTokens {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly sessionPublicId: string;
  readonly permissionsVersion: number;
  readonly user: AuthUserView;
}

export interface AuthUserView {
  readonly id: string;
  readonly fullName: string;
  readonly mobile: string;
  readonly email: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scope: { branchIds: readonly string[]; warehouseIds: readonly string[] };
  readonly mfa: boolean;
  readonly permissionsVersion: number;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
}

export interface LoginChallenge {
  readonly mfaRequired: true;
  readonly challengeId: string;
  readonly methods: readonly string[];
  readonly expiresIn: number;
  readonly maskMobile: string;
}

export type LoginResult = { readonly kind: 'tokens'; readonly tokens: IssuedAuthTokens } | {
  readonly kind: 'challenge';
  readonly challenge: LoginChallenge;
};

/** Purpose values accepted by `identity.otp_challenges.purpose` (DB CHECK). */
export const OTP_PURPOSES = [
  'login',
  'device_trust',
  'password_change',
  'action_confirm',
  'channel_credential',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Maps a public API purpose to the stored DB purpose. */
export function toStoredOtpPurpose(purpose: string): OtpPurpose {
  switch (purpose) {
    case 'login':
    case 'mfa':
      return 'login';
    case 'device_trust':
      return 'device_trust';
    case 'password_change':
    case 'password_reset':
      return 'password_change';
    case 'step_up':
    case 'action_confirm':
      return 'action_confirm';
    case 'channel_credential':
      return 'channel_credential';
    default:
      throw new AppError('VALIDATION_ERROR', {
        details: [{ field: 'purpose', rule: 'unsupported_otp_purpose' }],
      });
  }
}
