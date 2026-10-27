/**
 * Environment schema and production boot-guards (`ARCHITECTURE.md` §16,
 * `API.md` §10.5, `R1-C H-11`).
 *
 * Every variable of the root `.env.example` is validated with Zod, typed as
 * `AppConfig` and available through the `APP_CONFIG` token. `*_FILE` indirection
 * is supported for **every** variable (e.g. `JWT_ACCESS_SECRET_FILE`), which is
 * how Docker/Kubernetes secrets are injected without putting them in env values.
 *
 * Failing validation aborts boot (fail fast, 12-factor). In `production`
 * `assertProductionSafety` additionally refuses weak/placeholder secrets, the
 * mock SMS provider, docs exposure and a superuser/database-owner runtime role.
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';
export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type SmsMode = 'mock' | 'limo';

/** DI token for the validated configuration. */
export const APP_CONFIG = Symbol.for('saman.app-config');

function intFromEnv(defaultValue: number, min: number, max: number) {
  return z.coerce.number().int().min(min).max(max).default(defaultValue);
}

function boolFromEnv(defaultValue: boolean) {
  return z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');
}

function csvFromEnv(defaultValue: string) {
  return z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
}

function optionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().optional(),
  );
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

const ttlPattern = /^\d+[smhd]$/;

/**
 * The single source of truth for configuration. Field names are camelCase; the
 * matching environment variable is derived (`dbPoolMax` → `DB_POOL_MAX`) with a
 * short override table for the few irregular names.
 */
const EnvSchema = z.object({
  // --- Application ---------------------------------------------------------
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  appEnv: z.enum(['development', 'test', 'staging', 'production']).default('production'),
  appName: z.string().min(1).default('Saman ERP'),
  port: intFromEnv(4000, 1, 65535),
  /** Managed DB (Chabakan/RDS): one owner user runs both runtime and DDL. */
  dbManaged: boolFromEnv(false),
  host: z.string().min(1).default('0.0.0.0'),
  appUrl: z.string().url().default('https://erp.carexy.shop'),
  apiPrefix: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'lowercase path segment expected')
    .default('api'),
  apiVersion: z
    .string()
    .regex(/^v\d+$/, 'v<major> expected')
    .default('v1'),
  timezone: z.string().refine(isValidTimeZone, 'unknown IANA timezone').default('Asia/Tehran'),
  defaultLocale: z.enum(['fa-IR', 'en-US']).default('fa-IR'),
  docsEnabled: boolFromEnv(false),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Security ------------------------------------------------------------
  jwtAccessSecret: z.string().min(32).default('CHANGE_ME_64_CHARS_MINIMUM_RANDOM'),
  jwtAccessTtl: z.string().regex(ttlPattern).default('10m'),
  jwtRefreshTtl: z.string().regex(ttlPattern).default('7d'),
  /** HMAC pepper for OTP codes (`SECURITY.md`); required in production. */
  otpPepper: optionalString(),
  /** HMAC pepper for refresh-token hashes (`SECURITY.md`); required in production. */
  refreshPepper: optionalString(),
  encryptionKey: z.string().min(16).default('CHANGE_ME_32_BYTE_BASE64'),
  encryptionKeyVersion: intFromEnv(1, 1, 999),
  corsOrigins: csvFromEnv('https://erp.example.com'),
  cookieSecure: boolFromEnv(true),
  cookieDomain: optionalString(),
  trustProxy: boolFromEnv(true),
  securityHsts: boolFromEnv(true),
  rateLimitEnabled: boolFromEnv(true),
  rateLimitAuthPerMin: intFromEnv(10, 1, 10_000),
  rateLimitOtpPerHour: intFromEnv(5, 1, 10_000),
  rateLimitApiPerMin: intFromEnv(300, 1, 1_000_000),
  loginMaxFailed: intFromEnv(10, 1, 1000),
  loginLockMinutes: intFromEnv(15, 1, 24 * 60),

  // --- Database ------------------------------------------------------------
  databaseUrl: z.string().refine(isPostgresUrl, 'postgres:// URL expected').default(
    'postgres://saman_app:CHANGE_ME@postgres:5432/saman',
  ),
  migrationDatabaseUrl: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .refine(isPostgresUrl, 'postgres:// URL expected')
      .default('postgres://saman_migrator:CHANGE_ME@postgres:5432/saman'),
  ),
  dbSsl: boolFromEnv(false),
  dbSslCaPath: optionalString(),
  dbPoolMax: intFromEnv(20, 1, 500),
  dbStatementTimeoutMs: intFromEnv(5000, 1, 30 * 60 * 1000),
  dbIdleTimeoutMs: intFromEnv(30_000, 1, 60 * 60 * 1000),
  dbMigrationRole: z.string().min(1).default('saman_migrator'),
  dbSchema: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'lowercase identifier expected')
    .default('erp'),

  // --- Redis ---------------------------------------------------------------
  redisUrl: z.string().refine(isRedisUrl, 'redis:// URL expected').default('redis://redis:6379/0'),
  redisPassword: optionalString(),
  redisPrefix: z.string().default('saman:'),
  redisTls: boolFromEnv(false),

  // --- Object storage ------------------------------------------------------
  s3Endpoint: z.string().url().default('http://minio:9000'),
  s3Region: z.string().default('us-east-1'),
  s3Bucket: z.string().default('saman-files'),
  s3AccessKey: z.string().default('CHANGE_ME'),
  s3SecretKey: z.string().default('CHANGE_ME'),
  s3ForcePathStyle: boolFromEnv(true),
  s3PublicBaseUrl: optionalString(),
  uploadMaxMb: intFromEnv(20, 1, 1024),

  // --- SMS -----------------------------------------------------------------
  smsMode: z.enum(['mock', 'limo']).default('mock'),
  limoBaseUrl: z.string().url().default('https://api.limosms.com'),
  limoApiKey: optionalString(),
  limoSender: optionalString(),
  limoOtpPatternId: optionalString(),
  otpTtlSeconds: intFromEnv(120, 30, 3600),
  otpMaxAttempts: intFromEnv(5, 1, 20),

  // --- Channels ------------------------------------------------------------
  carexyApiBaseUrl: z.string().url().default('https://carexy.shop'),
  carexyApiKey: optionalString(),
  carexyWebhookSecret: optionalString(),
  digikalaApiBaseUrl: z.string().url().default('https://seller.digikala.com/open-api/v1'),
  digikalaClientId: optionalString(),
  digikalaClientSecret: optionalString(),
  digikalaWebhookSecret: optionalString(),
  channelSyncEnabled: boolFromEnv(true),
  /** In-process order-pull loop started by the API bootstrap (see auto-sync.scheduler). */
  autoSyncEnabled: boolFromEnv(true),
  /** In-process Digikala self-healing reconcile loop (see channel-reconciler.scheduler). */
  channelReconcileEnabled: boolFromEnv(true),
  channelStockDebounceMs: intFromEnv(3000, 0, 60_000),
  channelHttpTimeoutMs: intFromEnv(15_000, 1000, 120_000),

  // --- Jobs / worker -------------------------------------------------------
  workerConcurrency: intFromEnv(10, 1, 500),
  outboxBatchSize: intFromEnv(100, 1, 10_000),
  outboxPollIntervalMs: intFromEnv(1000, 50, 60_000),
  /** Max open pick tasks auto-assigned to one warehouse picker. */
  pickTaskCapacity: intFromEnv(20, 1, 500),

  // --- Observability -------------------------------------------------------
  metricsEnabled: boolFromEnv(true),
  metricsToken: optionalString(),
  otelEnabled: boolFromEnv(false),
  otelExporterOtlpEndpoint: optionalString(),
  sentryDsn: optionalString(),
  gitSha: z.string().default('unknown'),

  // --- Backups (used by backup sidecar / scripts) --------------------------
  backupEnabled: boolFromEnv(true),
  backupCron: z.string().default('0 2 * * *'),
  backupKeepDays: intFromEnv(30, 1, 3650),
  backupS3Prefix: z.string().default('backups/postgres'),
  backupEncryptionPassphrase: optionalString(),

  // --- Bootstrap (first run only) -----------------------------------------
  bootstrapAdminMobile: z
    .string()
    .regex(/^09\d{9}$/, 'Iranian mobile in 09XXXXXXXXX form expected')
    .default('09120000000'),
  bootstrapAdminPassword: z.string().min(8).default('CHANGE_ME_STRONG_PASSWORD'),
  bootstrapOrgName: z.string().min(1).default('کرکسی شاپ'),

  // --- Docker Compose image/ports -----------------------------------------
  postgresUser: z.string().default('saman'),
  postgresPassword: z.string().default('CHANGE_ME'),
  postgresDb: z.string().default('saman'),
  postgresPort: intFromEnv(5432, 1, 65535),
  redisPort: intFromEnv(6379, 1, 65535),
  minioRootUser: z.string().default('saman'),
  minioRootPassword: z.string().default('CHANGE_ME'),
  apiHostPort: intFromEnv(4000, 1, 65535),
  webHostPort: intFromEnv(8080, 1, 65535),
  domain: z.string().default('erp.carexy.shop'),
  acmeEmail: z.string().email().default('admin@carexy.shop'),
  imageTag: z.string().default('1.0.0'),
});

/** Validated, typed application configuration. */
export type AppConfig = z.infer<typeof EnvSchema>;

/** Environment variable name overrides for fields that are not plain camelCase. */
const ENV_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  port: 'APP_PORT',
  timezone: 'APP_TIMEZONE',
  defaultLocale: 'APP_DEFAULT_LOCALE',
  encryptionKey: 'APP_ENCRYPTION_KEY',
  encryptionKeyVersion: 'APP_ENCRYPTION_KEY_VERSION',
};

function camelToScreamingSnake(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Reads a file-backed secret (`*_FILE` indirection, R1-C H-11). */
function readFileBackedValue(filePath: string, envName: string): string {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable';
    throw new ConfigError('Invalid environment configuration', [
      `${envName}: cannot read secret file (${reason})`,
    ]);
  }
}

/**
 * Maps `process.env` to the camelCase schema input, resolving `*_FILE`
 * indirection first (an explicit value wins over an empty file path).
 */
export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fields: readonly string[] = Object.keys(EnvSchema.shape),
): Record<string, string | undefined> {
  const mapped: Record<string, string | undefined> = {};
  for (const field of fields) {
    const envName = ENV_NAME_OVERRIDES[field] ?? camelToScreamingSnake(field);
    const filePath = env[`${envName}_FILE`];
    mapped[field] =
      filePath !== undefined && filePath.trim() !== ''
        ? readFileBackedValue(filePath.trim(), `${envName}_FILE`)
        : env[envName];
  }
  return mapped;
}

/** Thrown when the environment is invalid; message is safe to log at boot. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[]) {
    super([message, ...problems.map((problem) => `- ${problem}`)].join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const PLACEHOLDER_PATTERN =
  /(change[_-]?me|changeme|placeholder|replace[_-]?me|your[_-]?(secret|key|password)|secret[_-]?here|example|dummy|insecure)/i;

/** True for empty, obvious placeholder or sample secret values. */
export function isPlaceholderSecret(value: string): boolean {
  return value.trim() === '' || PLACEHOLDER_PATTERN.test(value);
}

function base64ByteLength(value: string): number {
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return -1;
  }
}

function parsePostgresUser(databaseUrl: string): string | undefined {
  try {
    const username = decodeURIComponent(new URL(databaseUrl).username);
    return username === '' ? undefined : username;
  } catch {
    return undefined;
  }
}

const SUPERUSER_LIKE = new Set(['postgres', 'root', 'admin', 'superuser', 'super', 'owner']);
const PLACEHOLDER_ORIGIN = /(example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

/**
 * Production-only guards (`ARCHITECTURE.md` §10, `API.md` §1.17). Refuses to boot
 * rather than running a production service with dev settings; never echoes a
 * secret value in the failure details.
 */
export function assertProductionSafety(config: AppConfig): void {
  if (config.appEnv !== 'production') {
    return;
  }
  const problems: string[] = [];

  if (config.smsMode !== 'limo') {
    problems.push('SMS_MODE must be "limo" in production (mock provider is dev/test only).');
  }
  if (config.docsEnabled) {
    problems.push('DOCS_ENABLED must be false in production.');
  }
  if (!config.cookieSecure) {
    problems.push('COOKIE_SECURE must be true in production.');
  }
  if (!config.appUrl.startsWith('https://')) {
    problems.push('APP_URL must use https:// in production.');
  }
  if (!config.securityHsts) {
    problems.push('SECURITY_HSTS must be true in production.');
  }
  if (!config.rateLimitEnabled) {
    problems.push('RATE_LIMIT_ENABLED must be true in production.');
  }
  if (isPlaceholderSecret(config.jwtAccessSecret) || config.jwtAccessSecret.length < 32) {
    problems.push('JWT_ACCESS_SECRET is missing, too short or a placeholder.');
  }
  if (
    config.otpPepper === undefined ||
    isPlaceholderSecret(config.otpPepper) ||
    config.otpPepper.length < 32
  ) {
    problems.push('OTP_PEPPER must be a non-placeholder secret of at least 32 chars.');
  }
  if (
    config.refreshPepper === undefined ||
    isPlaceholderSecret(config.refreshPepper) ||
    config.refreshPepper.length < 32
  ) {
    problems.push('REFRESH_PEPPER must be a non-placeholder secret of at least 32 chars.');
  }
  if (config.jwtAccessSecret === config.encryptionKey) {
    problems.push('JWT_ACCESS_SECRET and APP_ENCRYPTION_KEY must be different secrets.');
  }
  if (isPlaceholderSecret(config.encryptionKey) || base64ByteLength(config.encryptionKey) !== 32) {
    problems.push('APP_ENCRYPTION_KEY must be a non-placeholder base64 value of 32 bytes.');
  }
  if (config.corsOrigins.length === 0) {
    problems.push('CORS_ORIGINS must list at least the SPA origin in production.');
  }
  if (config.corsOrigins.some((origin) => origin === '*' || PLACEHOLDER_ORIGIN.test(origin))) {
    problems.push('CORS_ORIGINS contains a wildcard or placeholder origin.');
  }

  if (!config.dbManaged) {
  const runtimeUser = parsePostgresUser(config.databaseUrl);
  if (runtimeUser === undefined) {
    problems.push('DATABASE_URL must contain a runtime role user.');
  } else {
    if (SUPERUSER_LIKE.has(runtimeUser.toLowerCase()) || /super|owner|root/i.test(runtimeUser)) {
      problems.push('DATABASE_URL must not use a superuser/owner-looking role.');
    }
    if (runtimeUser === config.dbMigrationRole) {
      problems.push('DATABASE_URL must not use the migration (DDL) role.');
    }
    const migrationUser = parsePostgresUser(config.migrationDatabaseUrl);
    if (migrationUser !== undefined && migrationUser === runtimeUser) {
      problems.push('DATABASE_URL and MIGRATION_DATABASE_URL must use different roles.');
    }
  }
  }

  if (problems.length > 0) {
    throw new ConfigError('Refusing to start: invalid production configuration.', problems);
  }
}

/** Parses and validates the environment, then enforces production guards. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(readEnvironment(env));
  if (!parsed.success) {
    throw new ConfigError(
      'Invalid environment configuration.',
      parsed.error.issues.map((issue) => {
        const field = issue.path.join('.');
        return field.length > 0 ? `${field}: ${issue.message}` : issue.message;
      }),
    );
  }
  assertProductionSafety(parsed.data);
  return parsed.data;
}
