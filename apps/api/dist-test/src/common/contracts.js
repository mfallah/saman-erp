"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TENANT = exports.CRYPTO = exports.EVENT_BUS = exports.AUDIT = exports.DB = void 0;
/** postgres.js client (pool). Injected everywhere a transaction is needed. */
exports.DB = Symbol.for('saman.db');
exports.AUDIT = Symbol.for('saman.audit');
exports.EVENT_BUS = Symbol.for('saman.events');
/** AES-256-GCM envelope encryption for channel credentials and secrets. */
exports.CRYPTO = Symbol.for('saman.crypto');
/** Request context accessor (AsyncLocalStorage-backed). */
exports.TENANT = Symbol.for('saman.tenant');
