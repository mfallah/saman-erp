import { describe, it } from 'node:test';

import { expect } from './support/expect';

import { CryptoService } from '../src/common/providers/crypto.service';
import { makeTestConfig } from './support/test-app';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function service(overrides: NodeJS.ProcessEnv = {}): CryptoService {
  return new CryptoService(
    makeTestConfig({
      APP_ENCRYPTION_KEY: TEST_KEY,
      APP_ENCRYPTION_KEY_VERSION: '2',
      ...overrides,
    }),
  );
}

describe('CryptoService (AES-256-GCM envelope)', () => {
  it('round-trips UTF-8 text including Persian', () => {
    const crypto = service();
    const plaintext = 'کلید دسترسی digikala: sk_live_very-secret';
    const envelope = crypto.encrypt(plaintext);
    expect(envelope.startsWith('v2:')).toBe(true);
    expect(crypto.decrypt(envelope)).toBe(plaintext);
  });

  it('uses a random IV per invocation (ciphertext is non-deterministic)', () => {
    const crypto = service();
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('rejects tampered ciphertext or tag', () => {
    const crypto = service();
    const parts = crypto.encrypt('secret').split(':');
    const tampered = [...parts] as [string, string, string, string];
    tampered[3] = Buffer.from('tampered').toString('base64url');
    expect(() => crypto.decrypt(tampered.join(':'))).toThrow();
  });

  it('rejects envelopes from a different key version', () => {
    const v1 = service({ APP_ENCRYPTION_KEY_VERSION: '1' });
    const v2 = service({ APP_ENCRYPTION_KEY_VERSION: '2' });
    const envelope = v1.encrypt('secret');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(() => v2.decrypt(envelope)).toThrow(/key version/);
  });

  it('rejects malformed envelopes', () => {
    const crypto = service();
    expect(() => crypto.decrypt('not-an-envelope')).toThrow(/malformed/);
    expect(() => crypto.decrypt('x1:aaaa:bbbb:cccc')).toThrow(/version/);
  });

  it('fingerprints deterministically without revealing the secret', () => {
    const crypto = service();
    const fingerprint = crypto.fingerprint('my-secret');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.fingerprint('my-secret')).toBe(fingerprint);
    expect(crypto.fingerprint('my-secret2')).not.toBe(fingerprint);
  });
});
