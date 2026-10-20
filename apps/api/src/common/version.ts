import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

const MANIFEST_PATHS = [
  join(__dirname, '..', '..', 'package.json'), // dist/common -> apps/api/package.json
  join(__dirname, '..', '..', '..', 'package.json'),
];

/**
 * Reads this app's `package.json` (name/version) for `/health/version`.
 * Resolution works both from `dist/` and from `tsx src/`.
 */
export function getAppVersion(): { name: string; version: string } {
  for (const candidate of MANIFEST_PATHS) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as PackageManifest;
      if (typeof manifest.version === 'string') {
        return { name: manifest.name ?? 'saman-api', version: manifest.version };
      }
    } catch {
      // Try the next candidate (dist nesting differs from source nesting).
    }
  }
  return { name: 'saman-api', version: '0.0.0' };
}
