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
  readonly Success?: boolean;
  readonly Message?: string;
  readonly MessageId?: readonly string[];
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
