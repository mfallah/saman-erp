/**
 * Serves the built admin SPA from the API container (no extra service needed).
 *
 * - only GET is handled; `/api/*`, `/health*` and `/metrics` keep returning API 404 JSON;
 * - existing files (assets) are streamed with their MIME type and a long cache;
 * - every other path falls back to `index.html` for client-side routing.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const API_PREFIXES = ['/api/', '/health', '/metrics', '/docs'];

export function registerWebUi(fastify: FastifyInstance, root: string | undefined): boolean {
  if (root === undefined || root.length === 0) return false;
  const base = resolve(root);
  const indexFile = join(base, 'index.html');
  if (!existsSync(indexFile)) return false;

  fastify.get('/*', (request, reply) => {
    const rawUrl = request.raw.url ?? '/';
    const pathOnly = decodeURIComponent(rawUrl.split('?')[0] ?? '/');

    if (API_PREFIXES.some((prefix) => pathOnly === prefix.replace(/\/$/, '') || pathOnly.startsWith(prefix))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'مسیر یافت نشد.' } });
    }

    const candidate = resolve(join(base, normalize(pathOnly)));
    if (!candidate.startsWith(base)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN' } });
    }

    if (pathOnly !== '/' && existsSync(candidate) && statSync(candidate).isFile()) {
      const ext = extname(candidate).toLowerCase();
      const cache = pathOnly.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
      return reply
        .header('Cache-Control', cache)
        .type(MIME[ext] ?? 'application/octet-stream')
        .send(createReadStream(candidate));
    }

    return reply
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(createReadStream(indexFile));
  });

  return true;
}
