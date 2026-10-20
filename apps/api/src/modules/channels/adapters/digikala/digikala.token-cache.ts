/**
 * OAuth2 client-credentials token cache (Redis hot store, in-process coalescing).
 * Tokens are never logged, persisted in `channel_api_calls`, or returned to the API.
 */
import type { KeyValueStore } from '../../ports/key-value.port';

export interface DigikalaTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
}

interface StoredToken {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
}

export class DigikalaTokenCache {
  private readonly inflight = new Map<string, Promise<DigikalaTokenSet | null>>();
  private readonly memory = new Map<string, DigikalaTokenSet>();

  constructor(private readonly store: KeyValueStore) {}

  private key(accountId: string): string {
    return `oauth:digikala:${accountId}`;
  }

  async get(accountId: string): Promise<DigikalaTokenSet | null> {
    const local = this.memory.get(accountId);
    if (local !== undefined && local.expiresAt > Date.now() + 5_000) return local;
    const raw = await this.store.get(this.key(accountId));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as StoredToken;
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.expiresAt !== 'number' ||
        parsed.expiresAt <= Date.now() + 5_000
      ) {
        return null;
      }
      const token: DigikalaTokenSet = {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
        expiresAt: parsed.expiresAt,
      };
      this.memory.set(accountId, token);
      return token;
    } catch {
      return null;
    }
  }

  async set(accountId: string, token: DigikalaTokenSet): Promise<void> {
    this.memory.set(accountId, token);
    const ttl = Math.max(30, Math.floor((token.expiresAt - Date.now()) / 1000) - 60);
    await this.store.set(
      this.key(accountId),
      JSON.stringify({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      }),
      ttl,
    );
  }

  async invalidate(accountId: string): Promise<void> {
    this.memory.delete(accountId);
    await this.store.del(this.key(accountId));
  }

  /** Single-flight loader: concurrent sync jobs share one token request. */
  async getOrLoad(
    accountId: string,
    loader: () => Promise<DigikalaTokenSet>,
  ): Promise<DigikalaTokenSet> {
    const cached = await this.get(accountId);
    if (cached !== null) return cached;
    const existing = this.inflight.get(accountId);
    if (existing !== undefined) {
      const shared = await existing;
      if (shared !== null) return shared;
    }
    const promise = loader()
      .then(async (token) => {
        await this.set(accountId, token);
        return token;
      })
      .finally(() => {
        this.inflight.delete(accountId);
      });
    this.inflight.set(accountId, promise);
    return promise;
  }
}
