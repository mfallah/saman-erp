/**
 * Cross-module integration contracts.
 *
 * These are the ONLY stable seams between feature modules and the platform
 * foundation. Feature modules inject the tokens below; the platform provides
 * the implementations (see apps/api/src/common/providers/*). Keeping these
 * contracts small prevents modules from importing each other's internals
 * (ARCHITECTURE §4.1 dependency rules).
 */
import type { Sql } from 'postgres';
import type { PermissionKey } from '@saman/shared';

/** postgres.js client (pool). Injected everywhere a transaction is needed. */
export const DB = Symbol.for('saman.db');
export type Db = Sql;

/** Request-scoped actor/tenant context, resolved by the auth guard. */
export interface TenantContext {
  requestId: string;
  orgId: bigint;
  orgPublicId: string;
  actorId: bigint | null;
  actorPublicId: string | null;
  permissions: readonly PermissionKey[];
  /** null = unrestricted for the actor's role (superadmin); [] = none. */
  branchIds: bigint[] | null;
  warehouseIds: bigint[] | null;
  ip?: string;
  userAgent?: string;
  sessionPublicId?: string;
  stepUpAt?: Date;
}

/** Append-only audit record, written in the same transaction as the write. */
export interface AuditEvent {
  action: string; // e.g. 'product.update', 'journal.post'
  entityType: string;
  entityId: string | bigint;
  orgId: bigint;
  actorId?: bigint | null;
  requestId: string;
  ip?: string;
  userAgent?: string;
  /** Never store secrets/PII here; masked diff only. */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
}
export const AUDIT = Symbol.for('saman.audit');
export interface AuditPort {
  record(tx: Db, event: AuditEvent): Promise<void>;
}

/** Transactional outbox: durable events dispatched by the worker. */
export interface DomainEvent {
  orgId: bigint;
  type: string; // e.g. 'sales.order.confirmed'
  aggregateType: string;
  aggregateId: string | bigint;
  payload: Record<string, unknown>;
  availableAt?: Date;
  dedupeKey?: string;
}
export const EVENT_BUS = Symbol.for('saman.events');
export interface EventPort {
  /** MUST be called inside the caller's transaction. */
  emit(tx: Db, event: DomainEvent): Promise<void>;
}

/** AES-256-GCM envelope encryption for channel credentials and secrets. */
export const CRYPTO = Symbol.for('saman.crypto');
export interface CryptoPort {
  encrypt(plaintext: string): string; // versioned envelope string
  decrypt(envelope: string): string;
  fingerprint(plaintext: string): string; // sha256 hex, for equality/logs
}

/** Request context accessor (AsyncLocalStorage-backed). */
export const TENANT = Symbol.for('saman.tenant');
export interface TenantAccessor {
  get(): TenantContext;
  tryGet(): TenantContext | undefined;
  run<T>(ctx: TenantContext, fn: () => T): T;
}
