import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SilentLogger } from '../infrastructure/logger';
import { OtpService, type OtpSmsSender } from './otp.service';
import type { OtpChallengeRow, OtpPurpose, OtpRepositoryPort } from './otp.repository';

type StoredChallenge = { -readonly [K in keyof OtpChallengeRow]: OtpChallengeRow[K] } & {
  createdAt: number;
};

class FakeOtpRepository implements OtpRepositoryPort {
  private readonly rows = new Map<string, StoredChallenge>();
  private sequence = 0;

  constructor(private readonly now: () => Date) {}

  async create(input: {
    organizationId: string | null;
    userId: string | null;
    mobile: string;
    purpose: OtpPurpose;
    codeHash: string;
    provider: string;
    ip: string | null;
    ttlSeconds: number;
    maxAttempts: number;
  }): Promise<string> {
    this.sequence += 1;
    const id = String(this.sequence);
    this.rows.set(id, {
      id,
      mobile: input.mobile,
      purpose: input.purpose,
      codeHash: input.codeHash,
      status: 'pending',
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      expiresAt: new Date(this.now().getTime() + input.ttlSeconds * 1000),
      createdAt: this.now().getTime(),
    });
    return id;
  }

  async attachProviderRequest(): Promise<void> {}

  async findById(id: string): Promise<OtpChallengeRow | null> {
    const row = this.rows.get(id);
    return row === undefined ? null : { ...row };
  }

  async consume(input: { id: string; purpose: OtpPurpose; codeHash: string }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (row === undefined) return false;
    if (
      row.status !== 'pending' ||
      row.purpose !== input.purpose ||
      row.codeHash !== input.codeHash ||
      row.attemptCount >= row.maxAttempts ||
      row.expiresAt === null ||
      row.expiresAt.getTime() <= this.now().getTime()
    ) {
      return false;
    }
    row.status = 'consumed';
    return true;
  }

  async registerFailure(id: string): Promise<{ attempts: number; locked: boolean }> {
    const row = this.rows.get(id);
    if (row === undefined || row.status !== 'pending') return { attempts: 0, locked: false };
    row.attemptCount += 1;
    if (row.attemptCount >= row.maxAttempts) row.status = 'locked';
    return { attempts: row.attemptCount, locked: row.status === 'locked' };
  }

  async invalidate(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined && row.status === 'pending') row.status = 'expired';
  }
}

function setup(): {
  service: OtpService;
  repository: FakeOtpRepository;
  sent: { channel: 'sms' | 'voice'; code: string }[];
  clock: { advance(ms: number): void };
} {
  let current = new Date('2026-10-20T10:00:00Z').getTime();
  const now = (): Date => new Date(current);
  const repository = new FakeOtpRepository(now);
  const sent: { channel: 'sms' | 'voice'; code: string }[] = [];
  const sms: OtpSmsSender = {
    sendOtp: async (input) => {
      sent.push({ channel: 'sms', code: input.code });
      return { smsMessageId: 'sms-1', providerMessageId: 'provider-1', costAmount: 1500 };
    },
    sendVoiceOtp: async (input) => {
      sent.push({ channel: 'voice', code: input.code });
      return { smsMessageId: 'sms-2', providerMessageId: 'provider-2' };
    },
  };
  const service = new OtpService({
    repository,
    sms,
    logger: new SilentLogger(),
    options: {
      pepper: 'test-pepper-0123456789',
      appEnv: 'test',
      now,
      codeGenerator: () => '123456',
    },
  });
  return {
    service,
    repository,
    sent,
    clock: {
      advance(ms: number) {
        current += ms;
      },
    },
  };
}

describe('OTP service', () => {
  it('stores only a peppered hash and consumes the code once', async () => {
    const { service, repository } = setup();
    const issued = await service.issue({
      organizationId: '1',
      userId: '2',
      mobile: '09121234567',
      purpose: 'login',
    });
    const stored = await repository.findById(issued.challengeId);
    assert.ok(stored !== null);
    assert.equal(stored.codeHash.length, 64);
    assert.equal(stored.codeHash.includes('123456'), false);
    assert.equal(stored.status, 'pending');
    assert.deepEqual(issued.channel, 'sms');

    const first = await service.verify({
      challengeId: issued.challengeId,
      code: '123456',
      purpose: 'login',
    });
    assert.deepEqual(first, { ok: true, reason: 'verified' });

    const second = await service.verify({
      challengeId: issued.challengeId,
      code: '123456',
      purpose: 'login',
    });
    assert.equal(second.ok, false);
  });

  it('locks the challenge after five wrong attempts', async () => {
    const { service } = setup();
    const issued = await service.issue({
      organizationId: '1',
      userId: '2',
      mobile: '09121234567',
      purpose: 'login',
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await service.verify({
        challengeId: issued.challengeId,
        code: '000000',
        purpose: 'login',
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, attempt === 5 ? 'locked' : 'invalid');
    }
    const correctAfterLock = await service.verify({
      challengeId: issued.challengeId,
      code: '123456',
      purpose: 'login',
    });
    assert.equal(correctAfterLock.reason, 'locked');
  });

  it('binds the code to its purpose without consuming attempts', async () => {
    const { service, repository } = setup();
    const issued = await service.issue({
      organizationId: '1',
      userId: '2',
      mobile: '09121234567',
      purpose: 'login',
    });
    const mismatch = await service.verify({
      challengeId: issued.challengeId,
      code: '123456',
      purpose: 'action_confirm',
    });
    assert.equal(mismatch.reason, 'purpose_mismatch');
    const stored = await repository.findById(issued.challengeId);
    assert.equal(stored?.attemptCount, 0);
    assert.equal(stored?.status, 'pending');
  });

  it('expires after 120 seconds', async () => {
    const { service, clock } = setup();
    const issued = await service.issue({
      organizationId: '1',
      userId: '2',
      mobile: '09121234567',
      purpose: 'device_trust',
    });
    clock.advance(121_000);
    const result = await service.verify({
      challengeId: issued.challengeId,
      code: '123456',
      purpose: 'device_trust',
    });
    assert.equal(result.reason, 'expired');
  });

  it('routes voice OTP through the voice provider', async () => {
    const { service, sent } = setup();
    await service.issue({
      organizationId: '1',
      userId: '2',
      mobile: '09121234567',
      purpose: 'password_change',
      channel: 'voice',
    });
    assert.deepEqual(sent, [{ channel: 'voice', code: '123456' }]);
  });
});
