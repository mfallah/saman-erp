/** Limo request/response shapes, exactly as documented in `limo-sms.txt`. */
export interface LimoSendSmsRequest {
  readonly SenderNumber: string;
  readonly Message: string;
  readonly MobileNumber: readonly string[];
  readonly SendToBlocksNumber?: boolean;
  readonly SendTimeSpan?: number;
}

export interface LimoPeerToPeerRequest {
  readonly SenderNumber: string;
  readonly Message: readonly string[];
  readonly MobileNumber: readonly string[];
  readonly SendToBlocksNumber?: boolean;
  readonly SendTimeSpan?: number;
}

export interface LimoPatternRequest {
  readonly OtpId: number;
  readonly ReplaceToken: readonly string[];
  readonly MobileNumber: string;
  readonly Send: boolean;
}

export interface LimoSendCodeRequest {
  readonly Mobile: string;
  readonly Footer: string;
}

export interface LimoVoiceOtpRequest {
  readonly PhoneNumber: string;
  readonly GenerateCode?: string;
}

export interface LimoProviderResponse {
  // Limo returns camelCase in the live API and PascalCase in older docs; accept both.
  readonly Success?: boolean;
  readonly success?: boolean;
  readonly Message?: string;
  readonly message?: string;
  readonly MessageId?: readonly string[] | string | number;
  readonly messageId?: string | number;
  readonly TotalAmount?: number | null;
  readonly GenerateCode?: string | null;
}

export interface LimoResult {
  readonly success: true;
  readonly messageIds: readonly string[];
  readonly totalAmount: number | null;
  readonly generatedCode: string | null;
  readonly providerMessage: string;
  readonly mock: boolean;
}
