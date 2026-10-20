/** Limo SMS contract constants (`F:\harness\erp-docs\limo-sms.txt`). */
export const LIMO_HOSTS = ['api.limosms.com'] as const;
export const LIMO_BASE_URL = 'https://api.limosms.com';

export const LIMO_PATHS = {
  sendSms: '/api/sendsms',
  sendPeerToPeer: '/api/sendpeertopeersms',
  sendPattern: '/api/sendpatternmessage',
  sendCode: '/api/sendcode',
  sendVoiceOtp: '/api/SendOTPVoice',
} as const;

export type SmsMode = 'mock' | 'limo';

/** Default mock unit price per segment (IRR) for budget tests/dev. */
export const DEFAULT_SMS_UNIT_PRICE_IRR = 1_500;
export const DEFAULT_SMS_DAILY_BUDGET_IRR = 5_000_000;
export const DEFAULT_VOICE_DAILY_BUDGET_IRR = 2_000_000;
export const OTP_TTL_SECONDS = 120;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_SENDS_PER_HOUR = 5;
export const OTP_RESENDS_PER_10_MIN = 3;
export const VOICE_OTP_PER_DAY = 3;
