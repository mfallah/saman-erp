/**
 * Adapter registry — one instance per supported channel, boot-asserted against
 * the code-declared host set (R1-security M-05).
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { IntegrationError } from '../domain/channel.types';
import type { AdapterAccount, ChannelCode } from '../domain/channel.types';
import { CHANNEL_ADAPTERS, type ChannelAdapter } from '../ports/channel-adapter.port';
import { assertAllowedUrl, assertDeclaredAdapterHosts } from '../infrastructure/egress';
import type { ChannelAccountRow } from '../repositories/channel-account.repository';

export interface ResolvedAdapterAccount {
  readonly adapter: ChannelAdapter;
  readonly account: AdapterAccount;
  readonly row: ChannelAccountRow;
}

@Injectable()
export class AdapterRegistry implements OnModuleInit {
  constructor(@Inject(CHANNEL_ADAPTERS) private readonly adapters: readonly ChannelAdapter[]) {}

  /** Fail fast at boot if an adapter declares a host outside its own set. */
  onModuleInit(): void {
    for (const adapter of this.adapters) {
      assertDeclaredAdapterHosts(adapter.code, [adapter.baseUrlFor(false)], adapter.declaredHosts);
      if (adapter.declaredHosts.length > 1) {
        assertDeclaredAdapterHosts(adapter.code, [adapter.baseUrlFor(true)], adapter.declaredHosts);
      }
    }
  }

  get(code: string): ChannelAdapter {
    const adapter = this.adapters.find((candidate) => candidate.code === code);
    if (adapter === undefined) {
      throw new IntegrationError('NOT_IMPLEMENTED', {
        messageFa: 'این کانال در نسخهٔ فعلی پشتیبانی نمی‌شود.',
        details: { code },
      });
    }
    return adapter;
  }

  list(): readonly ChannelAdapter[] {
    return this.adapters;
  }

  resolve(
    row: ChannelAccountRow,
    credentials: Readonly<Record<string, string>>,
  ): ResolvedAdapterAccount {
    const adapter = this.get(row.channelCode);
    const sandbox = row.settings['environment'] === 'sandbox';
    const baseUrl = adapter.baseUrlFor(sandbox);
    // M-05: `row.baseUrl` is deliberately ignored; only declared hosts are used.
    assertAllowedUrl(baseUrl, adapter.declaredHosts);
    return {
      adapter,
      row,
      account: {
        id: row.id,
        publicId: row.publicId,
        channelId: row.channelId,
        channelCode: row.channelCode as ChannelCode,
        organizationId: row.organizationId,
        baseUrl,
        sandbox,
        rateLimitPerMin: row.rateLimitPerMin,
        settings: row.settings,
        credentials,
      },
    };
  }
}
