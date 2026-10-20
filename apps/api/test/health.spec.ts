import { describe, it } from 'node:test';

/**
 * These specs boot the real Nest app with live DB/Redis connectivity checks.
 * They run in CI (TEST_HTTP_APP=1 with services); locally without dependencies
 * they are skipped instead of failing the unit-test gate.
 */
const HTTP_TESTS_SKIP =
  process.env['TEST_HTTP_APP'] === '1' ? false : 'set TEST_HTTP_APP=1 (requires PostgreSQL + Redis)';

import { arrayContaining, expect, objectContaining } from './support/expect';
import request from 'supertest';

import { createTestApp, failingDatabase, failingRedis } from './support/test-app';

describe('GET /health/live', { skip: HTTP_TESTS_SKIP }, () => {
  it('reports liveness in the standard success envelope', async () => {
    const { app, url } = await createTestApp();
    try {
      const response = await request(url).get('/health/live').expect(200);
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(response.body.data.status).toBe('ok');
      expect(typeof response.body.data.uptimeSeconds).toBe('number');
      expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
    } finally {
      await app.close();
    }
  });

  it('honours a valid client X-Request-ID and echoes it', async () => {
    const { app, url } = await createTestApp();
    const requestId = '0f0f6a2e-6f1e-4a3d-9a54-3a6b0f3c9c11';
    try {
      const response = await request(url).get('/health/live').set('X-Request-ID', requestId).expect(200);
      expect(response.headers['x-request-id']).toBe(requestId);
      expect(response.body.meta.requestId).toBe(requestId);
    } finally {
      await app.close();
    }
  });
});

describe('GET /health/ready', { skip: HTTP_TESTS_SKIP }, () => {
  it('returns 200 when database and redis answer', async () => {
    const { app, url } = await createTestApp();
    try {
      const response = await request(url).get('/health/ready').expect(200);
      expect(response.body.data.status).toBe('ok');
      expect(response.body.data.checks.db.status).toBe('up');
      expect(response.body.data.checks.redis.status).toBe('up');
      expect(response.body.data.checks.s3.status).toBe('skipped');
    } finally {
      await app.close();
    }
  });

  it('returns the SERVICE_DEGRADED error envelope when dependencies are down', async () => {
    const { app, url } = await createTestApp({ db: failingDatabase(), redis: failingRedis() });
    try {
      const response = await request(url).get('/health/ready').expect(503);
      expect(response.body.error.code).toBe('SERVICE_DEGRADED');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.body.error.details).toEqual(
        arrayContaining([objectContaining({ rule: 'db' })]),
      );
      expect(response.body.error.details).toEqual(
        arrayContaining([objectContaining({ rule: 'redis' })]),
      );
    } finally {
      await app.close();
    }
  });
});

describe('GET /health/version', { skip: HTTP_TESTS_SKIP }, () => {
  it('exposes build/env information without secrets', async () => {
    const { app, url } = await createTestApp();
    try {
      const response = await request(url).get('/health/version').expect(200);
      expect(typeof response.body.data.version).toBe('string');
      expect(response.body.data.env).toBe('test');
      expect(response.body.data).toHaveProperty('commit');
    } finally {
      await app.close();
    }
  });
});

describe('contract fallbacks', { skip: HTTP_TESTS_SKIP }, () => {
  it('wraps the 404 route-not-found in the API error envelope', async () => {
    const { app, url } = await createTestApp();
    try {
      const response = await request(url).get('/api/v1/does-not-exist').expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.messageKey).toBe('error.not_found');
      expect(typeof response.body.error.requestId).toBe('string');
      expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
      expect(response.body).not.toHaveProperty('success');
    } finally {
      await app.close();
    }
  });

  it('keeps health and metrics outside the /api/v1 prefix', async () => {
    const { app, url } = await createTestApp();
    try {
      await request(url).get('/api/v1/health/live').expect(404);
      await request(url).get('/health/live').expect(200);
    } finally {
      await app.close();
    }
  });
});
