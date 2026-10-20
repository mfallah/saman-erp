/**
 * Channel price source port. Pricing owns channel price snapshots; the channels
 * module never reads `pricing.*` tables directly (ARCHITECTURE §4.1).
 */
import type { PriceValue } from '../domain/channel.types';

export const CHANNEL_PRICE_SOURCE = Symbol.for('saman.channel-price-source');

export interface ChannelPriceSourcePort {
  getPublishedPrice(accountId: string, variantId: string): Promise<PriceValue | null>;
}
