#!/usr/bin/env node
/**
 * TD-15 standalone proof: run the atomic OTP consume statement directly against
 * PostgreSQL, concurrently, and print PASS/FAIL for every invariant.
 *
 * Usage (repo root):
 *   DATABASE_URL=postgres://saman_app@127.0.0.1:5432/saman_verify4 \
 *   CLEANUP_DATABASE_URL=postgres://saman_migrator@127.0.0.1:5432/saman_verify4 \
 *   node scripts/verify-otp-race.mjs
 *
 * Defaults target the throw-away local verification cluster documented in
 * docs/VERIFICATION.md; nothing is written outside `erp.otp_challenges` rows
 * whose mobile starts with `09race-`, and those are deleted at the end.
 */
import { createHash } from 'node:crypto';

import postgres from 'postgres';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres@127.0.0.1:5432/saman_verify4';
const CLEANUP_URL = process.env.CLEANUP_DATABASE_URL ?? DATABASE_URL;
const MAX_ATTEMPTS = 5;

const CODE_HASH = createHash('sha256').update('race-proof-code').digest('hex');
const WRONG_HASH = createHash('sha256').update('wrong-code').digest('hex');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` â€” ${detail}`}`);
}

/**
 * The one-statement verify+consume contract (same SQL as
 * AuthRepository.consumeOtpChallenge, TD-15):
 *   update erp.otp_challenges set consumed_at = now(), attempt_count = attempt_count + 1
 *    where public_id = $1 and consumed_at is null and expires_at > now()
 *      and code_hash = $2 returning id
 * plus the status/attempt guards that keep lockout unbypassable.
 */
async function consume(client, publicId, codeHash, maxAttempts = MAX_ATTEMPTS) {
  const rows = await client`
    update erp.otp_challenges
       set consumed_at = now(),
           verified_at = coalesce(verified_at, now()),
           status = 'consumed',
           attempt_count = attempt_count + 1
     where public_id = ${publicId}::uuid
       and consumed_at is null
       and expires_at > now()
       and code_hash = ${codeHash}
       and status in ('pending', 'verified')
       and attempt_count < ${maxAttempts}
    returning id
  `;
  return rows.length;
}

async function failAttempt(client, publicId, maxAttempts = MAX_ATTEMPTS) {
  const rows = await client`
    update erp.otp_challenges
       set attempt_count = attempt_count + 1
     where public_id = ${publicId}::uuid
       and consumed_at is null
       and expires_at > now()
       and attempt_count < ${maxAttempts}
    returning attempt_count
  `;
  return rows.length;
}

async function insertChallenge(client, { mobile, codeHash, expiresIn, maxAttempts = MAX_ATTEMPTS }) {
  const rows = await client`
    insert into erp.otp_challenges (
      organization_id, user_id, mobile, purpose, code_hash, expires_at, max_attempts, status
    ) values (
      null, null, ${mobile}, 'login', ${codeHash},
      now() + (${expiresIn} * interval '1 second'), ${maxAttempts}, 'pending'
    ) returning public_id
  `;
  return String(rows[0].public_id);
}

async function readChallenge(client, publicId) {
  const rows = await client`
    select consumed_at, attempt_count, status, expires_at
    from erp.otp_challenges where public_id = ${publicId}::uuid
  `;
  return rows[0];
}

async function cleanup(client) {
  await client`delete from erp.otp_challenges where mobile like '09race-%'`;
}

async function main() {
  console.log(`OTP race proof against ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  const app = postgres(DATABASE_URL, { max: 4, connect_timeout: 10, onnotice: () => {} });
  const cleanupClient = postgres(CLEANUP_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  // Two dedicated sessions: a real concurrent race, not a pipelined queue.
  const a = postgres(DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const b = postgres(DATABASE_URL, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const table = await app`
      select 1 from information_schema.tables
      where table_schema = 'erp' and table_name = 'otp_challenges'
    `;
    if (table.length === 0) {
      console.log('FAIL  erp.otp_challenges exists â€” run db:migrate first');
      process.exitCode = 1;
      return;
    }
    const now = Date.now();
    await cleanup(cleanupClient);

    /* 1. Two concurrent verifications, same code: exactly one consumes. */
    const raceId = await insertChallenge(app, {
      mobile: `09race-a-${now % 1_000_000}`,
      codeHash: CODE_HASH,
      expiresIn: 120,
    });
    const wins = await Promise.all([
      consume(a, raceId, CODE_HASH),
      consume(b, raceId, CODE_HASH),
    ]);
    const stored = await readChallenge(app, raceId);
    check('concurrent consume: exactly one winner', wins[0] + wins[1] === 1, `wins=${wins.join('+')}`);
    check('consumed_at is set by the winner', stored.consumed_at !== null);
    check('attempt_count incremented exactly once', Number(stored.attempt_count) === 1, `attempts=${stored.attempt_count}`);

    /* 2. Replay of the consumed challenge cannot win and cannot inflate attempts. */
    const replay = await Promise.all([
      consume(a, raceId, CODE_HASH),
      consume(b, raceId, CODE_HASH),
    ]);
    const afterReplay = await readChallenge(app, raceId);
    check('replay after consumption: zero winners', replay[0] + replay[1] === 0, `wins=${replay.join('+')}`);
    check('replay does not bypass the attempt counter', Number(afterReplay.attempt_count) === 1, `attempts=${afterReplay.attempt_count}`);

    /* 3. Concurrent wrong codes stop at max_attempts and never consume. */
    const lockId = await insertChallenge(app, {
      mobile: `09race-b-${now % 1_000_000}`,
      codeHash: WRONG_HASH,
      expiresIn: 120,
      maxAttempts: 2,
    });
    const wrongWins = await Promise.all([
      consume(a, lockId, CODE_HASH),
      consume(b, lockId, CODE_HASH),
      failAttempt(app, lockId, 2),
      failAttempt(app, lockId, 2),
    ]);
    const lockStored = await readChallenge(app, lockId);
    check('wrong code: zero winners', wrongWins.slice(0, 2).every((n) => n === 0));
    check('lockout cap: attempts <= max_attempts', Number(lockStored.attempt_count) <= 2, `attempts=${lockStored.attempt_count}`);
    check('locked challenge is not consumed', lockStored.consumed_at === null);

    const afterLock = await consume(a, lockId, WRONG_HASH, 2);
    const lockAfterCorrect = await readChallenge(app, lockId);
    check('correct code after lockout cannot bypass the budget', afterLock === 0);
    check('lockout leaves challenge unconsumed', lockAfterCorrect.consumed_at === null);

    /* 4. Expired challenge can never be consumed. */
    const expiredId = await insertChallenge(app, {
      mobile: `09race-c-${now % 1_000_000}`,
      codeHash: CODE_HASH,
      expiresIn: -5,
    });
    const expiredWin = await consume(a, expiredId, CODE_HASH);
    check('expired challenge: zero winners', expiredWin === 0);

    /* 5. Wrong hash cannot consume. */
    const wrongHashId = await insertChallenge(app, {
      mobile: `09race-d-${now % 1_000_000}`,
      codeHash: CODE_HASH,
      expiresIn: 120,
    });
    const wrongHashWin = await consume(a, wrongHashId, WRONG_HASH);
    check('wrong code hash: zero winners', wrongHashWin === 0);
  } finally {
    try {
      // Every row this script inserts carries the `09race-` mobile prefix.
      await cleanup(cleanupClient);
    } catch (error) {
      console.log(`WARN  cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Promise.all([app.end({ timeout: 2 }), a.end({ timeout: 2 }), b.end({ timeout: 2 }), cleanupClient.end({ timeout: 2 })]);
  }

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\nSUMMARY: ${results.length - failed}/${results.length} checks passed`);
  console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`FAIL  unexpected error â€” ${error instanceof Error ? error.message : String(error)}`);
  console.log('RESULT: FAIL');
  process.exitCode = 1;
});
