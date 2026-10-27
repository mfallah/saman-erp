import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import postgres from 'postgres';
import { AppError } from '@saman/shared';

import { expect } from './support/expect';
import { makeTestConfig } from './support/test-app';
import type { AuditPort, Db } from '../src/common/contracts';
import { AuthService } from '../src/modules/identity/auth.service';
import { AuthRepository } from '../src/modules/identity/auth.repository';
import { OtpService } from '../src/modules/identity/otp.service';
import { PasswordService } from '../src/modules/identity/password.service';
import type { AuthRateLimitService } from '../src/modules/identity/auth-rate-limit.service';

/**
 * TD-15 concurrency proof against a real PostgreSQL.
 *
 * Two `AuthService.verifyOtp()` calls race with the SAME live challenge and the
 * SAME code. The atomic `UPDATE … WHERE consumed_at IS NULL AND code_hash = $2
 * RETURNING id` may only win once, so exactly one call may return a session.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database (CI/integration
 * mode); the standalone `scripts/verify-otp-race.mjs` proves the same SQL without
 * the API. The connection must be a non-superuser runtime role (the config loader
 * rejects superusers); cleanup deletes its own rows through
 * `TEST_CLEANUP_DATABASE_URL`, a role that may DELETE (`saman_worker` by default
 * in the local verification cluster).
 */
const APP_URL = process.env['TEST_DATABASE_URL'];
const CLEANUP_URL = process.env['TEST_CLEANUP_DATABASE_URL'] ?? APP_URL;
/** Only used for config validation (the service never opens this connection). */
const MIGRATION_URL =
  process.env['TEST_MIGRATION_DATABASE_URL'] ??
  'postgres://saman_migrator@127.0.0.1:5432/saman_verify4';
const SKIP = APP_URL === undefined || CLEANUP_URL === undefined
  ? 'TEST_DATABASE_URL / TEST_CLEANUP_DATABASE_URL are not set'
  : false;

const PEPPER = 'test-otp-pepper-that-is-long-enough-32chars';
const CODE = '123456';

function context(): { ip?: string; ipPrefix: string; userAgentHash: string; requestId: string } {
  return { ipPrefix: '127.0.0.0/24', userAgentHash: 'ua-hash', requestId: randomUUID() };
}

describe('OTP verification race (TD-15, real PostgreSQL)', () => {
  it('allows exactly one of two concurrent verifies to create a session', { skip: SKIP }, async () => {
    const config = makeTestConfig({
      DATABASE_URL: APP_URL,
      MIGRATION_DATABASE_URL: MIGRATION_URL,
      OTP_PEPPER: PEPPER,
    });
    const sql = postgres(APP_URL as string, { max: 4, onnotice: () => {} });
    const cleanup = postgres(CLEANUP_URL as string, { max: 1, onnotice: () => {} });
    const challenges: string[] = [];
    const sessions: string[] = [];
    try {
      const orgRows = await sql`
        select id from erp.organizations where status <> 'archived' order by id asc limit 1
      `;
      const userRows = await sql`
        select id from erp.users
        where deleted_at is null and status = 'active' order by id asc limit 1
      `;
      if (orgRows[0] === undefined || userRows[0] === undefined) {
        throw new Error('database is not seeded (organization/active user missing)');
      }
      const orgId = orgRows[0]['id'];
      const userId = userRows[0]['id'];

      const otp = new OtpService(PEPPER);
      const mobile = `09race${String(Date.now()).slice(-6)}`;
      const codeHash = otp.hash(mobile, 'login', CODE);
      const inserted = await sql`
        insert into erp.otp_challenges (
          organization_id, user_id, mobile, purpose, code_hash, expires_at, max_attempts, status
        ) values (
          ${orgId}, ${userId}, ${mobile}, 'login', ${codeHash}, now() + interval '120 seconds', 5, 'pending'
        ) returning public_id
      `;
      const challengeId = String(inserted[0]?.['public_id']);
      challenges.push(challengeId);

      const sessionsBefore = await sql`
        select count(*)::int as count from erp.auth_sessions where user_id = ${userId}
      `;
      const baseline = Number(sessionsBefore[0]?.['count'] ?? 0);

      const service = new AuthService(
        config,
        sql as unknown as Db,
        { record: async () => {} } satisfies AuditPort,
        new AuthRepository(sql as unknown as Db),
        new PasswordService(),
        {} as AuthRateLimitService,
      );

      const results = await Promise.allSettled([
        service.verifyOtp({ challengeId, code: CODE }, context()),
        service.verifyOtp({ challengeId, code: CODE }, context()),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.verifyOtp>>> =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const failure = rejected[0]?.reason;
      expect(failure instanceof AppError ? failure.code : String(failure)).toBe('OTP_INVALID');

      const winner = fulfilled[0]?.value;
      const winnerBody = winner?.body as { sessionId?: string } | undefined;
      if (winnerBody?.sessionId !== undefined) sessions.push(winnerBody.sessionId);
      expect(winner?.status).toBe(200);
      expect(winnerBody?.sessionId === undefined ? undefined : typeof winnerBody.sessionId).toBe(
        'string',
      );

      const stored = await sql`
        select consumed_at, attempt_count from erp.otp_challenges where public_id = ${challengeId}::uuid
      `;
      expect(stored[0]?.['consumed_at'] === null ? null : 'set').toBe('set');
      expect(Number(stored[0]?.['attempt_count'])).toBe(1);

      const sessionsAfter = await sql`
        select count(*)::int as count from erp.auth_sessions where user_id = ${userId}
      `;
      expect(Number(sessionsAfter[0]?.['count'] ?? 0)).toBe(baseline + 1);

      // Replay after the winner: no second session, no attempt-counter bypass.
      let replayCode = 'none';
      try {
        await service.verifyOtp({ challengeId, code: CODE }, context());
      } catch (error) {
        replayCode = error instanceof AppError ? error.code : String(error);
      }
      expect(replayCode).toBe('OTP_INVALID');
      const afterReplay = await sql`
        select attempt_count from erp.otp_challenges where public_id = ${challengeId}::uuid
      `;
      expect(Number(afterReplay[0]?.['attempt_count'])).toBe(1);
      const sessionsAfterReplay = await sql`
        select count(*)::int as count from erp.auth_sessions where user_id = ${userId}
      `;
      expect(Number(sessionsAfterReplay[0]?.['count'] ?? 0)).toBe(baseline + 1);
    } finally {
      for (const id of challenges) {
        await cleanup`delete from erp.otp_challenges where public_id = ${id}::uuid`;
      }
      for (const id of sessions) {
        await cleanup`delete from erp.auth_sessions where public_id = ${id}::uuid`;
      }
      await sql.end({ timeout: 2 });
      await cleanup.end({ timeout: 2 });
    }
  });

  it('locks out after max attempts and never consumes on a wrong code', { skip: SKIP }, async () => {
    const config = makeTestConfig({
      DATABASE_URL: APP_URL,
      MIGRATION_DATABASE_URL: MIGRATION_URL,
      OTP_PEPPER: PEPPER,
    });
    const sql = postgres(APP_URL as string, { max: 2, onnotice: () => {} });
    const cleanup = postgres(CLEANUP_URL as string, { max: 1, onnotice: () => {} });
    let challengeId: string | undefined;
    try {
      const orgRows = await sql`
        select id from erp.organizations where status <> 'archived' order by id asc limit 1
      `;
      const userRows = await sql`
        select id from erp.users
        where deleted_at is null and status = 'active' order by id asc limit 1
      `;
      if (orgRows[0] === undefined || userRows[0] === undefined) {
        throw new Error('database is not seeded (organization/active user missing)');
      }
      const otp = new OtpService(PEPPER);
      const mobile = `09lock${String(Date.now()).slice(-6)}`;
      const inserted = await sql`
        insert into erp.otp_challenges (
          organization_id, user_id, mobile, purpose, code_hash, expires_at, max_attempts, status
        ) values (
          ${orgRows[0]['id']}, ${userRows[0]['id']}, ${mobile}, 'login',
          ${otp.hash(mobile, 'login', CODE)}, now() + interval '120 seconds', 2, 'pending'
        ) returning public_id
      `;
      challengeId = String(inserted[0]?.['public_id']);

      const service = new AuthService(
        config,
        sql as unknown as Db,
        { record: async () => {} } satisfies AuditPort,
        new AuthRepository(sql as unknown as Db),
        new PasswordService(),
        {} as AuthRateLimitService,
      );

      const codes: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await service.verifyOtp({ challengeId, code: '000000' }, context());
          codes.push('ok');
        } catch (error) {
          codes.push(error instanceof AppError ? error.code : String(error));
        }
      }
      expect(codes).toEqual(['OTP_INVALID', 'OTP_ATTEMPTS_EXCEEDED', 'OTP_ATTEMPTS_EXCEEDED']);

      const stored = await sql`
        select consumed_at, attempt_count, status from erp.otp_challenges
        where public_id = ${challengeId}::uuid
      `;
      expect(stored[0]?.['consumed_at'] === null ? null : 'set').toBeNull();
      expect(Number(stored[0]?.['attempt_count'])).toBe(2);
      expect(String(stored[0]?.['status'])).toBe('locked');

      // Correct code after lockout must still fail (no budget reset/bypass).
      let lockedCode = 'none';
      try {
        await service.verifyOtp({ challengeId, code: CODE }, context());
      } catch (error) {
        lockedCode = error instanceof AppError ? error.code : String(error);
      }
      expect(lockedCode).toBe('OTP_ATTEMPTS_EXCEEDED');
    } finally {
      if (challengeId !== undefined) {
        await cleanup`delete from erp.otp_challenges where public_id = ${challengeId}::uuid`;
      }
      await sql.end({ timeout: 2 });
      await cleanup.end({ timeout: 2 });
    }
  });
});
