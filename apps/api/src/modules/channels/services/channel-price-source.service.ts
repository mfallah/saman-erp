/**
 * Channel price source adapter: exposes the *published* price of a variant on a
 * channel's price list to the channels module (price push).
 *
 * price_lists.channel_account_id / channel_accounts.price_list_id link a list to
 * an account; price_list_items holds effective-dated integer IRR amounts.
 */
import { Inject, Injectable } from '@nestjs/common';

import { DB, type Db } from '../../../common/contracts';
import { CHANNEL_PRICE_SOURCE, type ChannelPriceSourcePort } from '../ports/channel-price.port';
import type { PriceValue } from '../domain/channel.types';

interface PriceRow {
  price_amount: string;
}

@Injectable()
export class SqlChannelPriceSource implements ChannelPriceSourcePort {
  constructor(@Inject(DB) private readonly db: Db) {}

  async getPublishedPrice(accountId: string, variantId: string): Promise<PriceValue | null> {
    const rows = await this.db<PriceRow[]>`
      select i.price_amount::text as price_amount
      from erp.channel_accounts a
      join erp.price_lists l
        on l.is_active = true
       and l.deleted_at is null
       and l.organization_id = a.organization_id
       and (l.id = a.price_list_id or l.channel_account_id = a.id)
      join erp.price_list_items i
        on i.price_list_id = l.id
       and i.is_active = true
       and i.deleted_at is null
       and i.product_variant_id = ${variantId}::bigint
       and i.effective_from <= now()
       and (i.effective_to is null or i.effective_to > now())
      where a.id = ${accountId}::bigint
        and a.deleted_at is null
      order by l.priority desc, i.effective_from desc, i.id desc
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return { price: row.price_amount };
  }
}

export const CHANNEL_PRICE_SOURCE_PROVIDER = {
  provide: CHANNEL_PRICE_SOURCE,
  useClass: SqlChannelPriceSource,
};
