"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const expect_1 = require("./support/expect");
const crypto_service_1 = require("../src/common/providers/crypto.service");
const test_app_1 = require("./support/test-app");
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
function service(overrides = {}) {
    return new crypto_service_1.CryptoService((0, test_app_1.makeTestConfig)({
        APP_ENCRYPTION_KEY: TEST_KEY,
        APP_ENCRYPTION_KEY_VERSION: '2',
        ...overrides,
    }));
}
(0, node_test_1.describe)('CryptoService (AES-256-GCM envelope)', () => {
    (0, node_test_1.it)('round-trips UTF-8 text including Persian', () => {
        const crypto = service();
        const plaintext = 'کلید دسترسی digikala: sk_live_very-secret';
        const envelope = crypto.encrypt(plaintext);
        (0, expect_1.expect)(envelope.startsWith('v2:')).toBe(true);
        (0, expect_1.expect)(crypto.decrypt(envelope)).toBe(plaintext);
    });
    (0, node_test_1.it)('uses a random IV per invocation (ciphertext is non-deterministic)', () => {
        const crypto = service();
        (0, expect_1.expect)(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
    });
    (0, node_test_1.it)('rejects tampered ciphertext or tag', () => {
        const crypto = service();
        const parts = crypto.encrypt('secret').split(':');
        const tampered = [...parts];
        tampered[3] = Buffer.from('tampered').toString('base64url');
        (0, expect_1.expect)(() => crypto.decrypt(tampered.join(':'))).toThrow();
    });
    (0, node_test_1.it)('rejects envelopes from a different key version', () => {
        const v1 = service({ APP_ENCRYPTION_KEY_VERSION: '1' });
        const v2 = service({ APP_ENCRYPTION_KEY_VERSION: '2' });
        const envelope = v1.encrypt('secret');
        (0, expect_1.expect)(envelope.startsWith('v1:')).toBe(true);
        (0, expect_1.expect)(() => v2.decrypt(envelope)).toThrow(/key version/);
    });
    (0, node_test_1.it)('rejects malformed envelopes', () => {
        const crypto = service();
        (0, expect_1.expect)(() => crypto.decrypt('not-an-envelope')).toThrow(/malformed/);
        (0, expect_1.expect)(() => crypto.decrypt('x1:aaaa:bbbb:cccc')).toThrow(/version/);
    });
    (0, node_test_1.it)('fingerprints deterministically without revealing the secret', () => {
        const crypto = service();
        const fingerprint = crypto.fingerprint('my-secret');
        (0, expect_1.expect)(fingerprint).toMatch(/^[0-9a-f]{64}$/);
        (0, expect_1.expect)(crypto.fingerprint('my-secret')).toBe(fingerprint);
        (0, expect_1.expect)(crypto.fingerprint('my-secret2')).not.toBe(fingerprint);
    });
});
