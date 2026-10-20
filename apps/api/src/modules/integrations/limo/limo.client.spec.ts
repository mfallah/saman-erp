import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SilentLogger } from '../infrastructure/logger';
import { LimoSmsClient, estimateSmsSegments } from './limo.client';
import { LimoError } from './limo.errors';
import { LIMO_BASE_URL, LIMO_PATHS } from './limo.constants';

interface Captured {
  url: string;
  init: RequestInit;
}

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): LimoSmsClient {
  return new LimoSmsClient({
    mode: 'limo',
    apiKey: 'limo-key-123',
    appEnv: 'test',
    logger: new SilentLogger(),
    fetchImpl,
    sleepImpl: async () => undefined,
    random: () => 0,
    timeoutMs: 1000,
  });
}

function ok(): Response {
  return new Response(
    JSON.stringify({ Success: true, Message: 'ok', MessageId: ['m-1'], TotalAmount: 1500 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Limo SMS client (5 documented endpoints)', () => {
  it('calls all five endpoints with the ApiKey header and documented bodies', async () => {
    const calls: Captured[] = [];
    const sms = client(async (url, init) => {
      calls.push({ url, init });
      return ok();
    });

    await sms.sendSms({
      senderNumber: '3000',
      message: 'سلام',
      mobiles: ['09121234567'],
    });
    await sms.sendPeerToPeer({
      senderNumber: '3000',
      messages: ['اول', 'دوم'],
      mobiles: ['09121234567', '09351234567'],
    });
    await sms.sendPattern({ otpId: 1234, replaceTokens: ['54321'], mobile: '09121234567' });
    await sms.sendCode({ mobile: '09121234567', footer: 'سامان' });
    await sms.sendVoiceOtp({ phoneNumber: '09121234567', generateCode: '54321' });

    assert.deepEqual(
      calls.map((call) => new URL(call.url).pathname),
      [
        LIMO_PATHS.sendSms,
        LIMO_PATHS.sendPeerToPeer,
        LIMO_PATHS.sendPattern,
        LIMO_PATHS.sendCode,
        LIMO_PATHS.sendVoiceOtp,
      ],
    );
    for (const call of calls) {
      assert.equal(call.url.startsWith(LIMO_BASE_URL), true);
      assert.equal(call.init.method, 'POST');
      assert.equal((call.init.headers as Record<string, string>)['apiKey'], 'limo-key-123');
    }
    const pattern = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(pattern, {
      OtpId: 1234,
      ReplaceToken: ['54321'],
      MobileNumber: '09121234567',
      Send: true,
    });
    const voice = JSON.parse(String(calls[4]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(voice, { PhoneNumber: '09121234567', GenerateCode: '54321' });
  });

  it('mock mode never performs a network call and is deterministic', async () => {
    let fetched = 0;
    const mock = new LimoSmsClient({
      mode: 'mock',
      appEnv: 'test',
      logger: new SilentLogger(),
      fetchImpl: async () => {
        fetched += 1;
        return ok();
      },
    });
    const first = await mock.sendPattern({
      otpId: 1,
      replaceTokens: ['111111'],
      mobile: '09121234567',
    });
    const second = await mock.sendPattern({
      otpId: 1,
      replaceTokens: ['111111'],
      mobile: '09121234567',
    });
    assert.equal(fetched, 0);
    assert.equal(first.mock, true);
    assert.deepEqual(first.messageIds, second.messageIds);
  });

  it('maps provider Success=false to a Persian budget error', async () => {
    const sms = client(
      async () =>
        new Response(JSON.stringify({ Success: false, Message: 'اعتبار کافی نیست' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await assert.rejects(
      sms.sendSms({ senderNumber: '3000', message: 'تست', mobiles: ['09121234567'] }),
      (error: unknown) =>
        error instanceof LimoError &&
        error.code === 'BUDGET_EXHAUSTED' &&
        error.messageFa.includes('اعتبار'),
    );
  });

  it('rejects invalid Iranian mobiles before calling the provider', async () => {
    let fetched = 0;
    const sms = client(async () => {
      fetched += 1;
      return ok();
    });
    await assert.rejects(
      sms.sendSms({ senderNumber: '3000', message: 'تست', mobiles: ['12345'] }),
      (error: unknown) => error instanceof LimoError && error.code === 'INVALID_MOBILE',
    );
    assert.equal(fetched, 0);
  });

  it('estimates SMS segments for the monetary budget', () => {
    assert.equal(estimateSmsSegments('کوتاه'), 1);
    assert.equal(estimateSmsSegments('x'.repeat(71)), 2);
  });
});
