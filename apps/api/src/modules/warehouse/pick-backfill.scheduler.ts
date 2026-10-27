import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { Inject } from '@nestjs/common';

import { DB, type Db } from '../../common/contracts';
import { PickAssignmentService } from './pick-assignment.service';

const TICK_MS = 5 * 60_000;
const MAX_ORDERS_PER_TICK = 40;

/**
 * Backlog safety net: channel orders whose line items arrived after the
 * materialisation event (re-pulls, backfills, manual repair) never went through
 * the outbox pick-assignment hook. Every few minutes this fills that gap so the
 * pick station is never silently empty.
 */
@Injectable()
export class PickBackfillScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PickBackfillScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly assignment: PickAssignmentService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    // Run once shortly after boot instead of waiting a full interval.
    setTimeout(() => {
      void this.tick();
    }, 20_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orders = await this.db<
        { org_id: string; order_id: string }[]
      >`
        select o.organization_id::text as org_id, o.id::text as order_id
          from erp.sales_orders o
         where o.deleted_at is null
           and exists (select 1 from erp.sales_order_lines l where l.order_id = o.id)
           and not exists (select 1 from erp.pick_tasks t where t.order_id = o.id)
           and o.fulfillment_status in ('unfulfilled', 'allocated', 'picking')
         order by o.id
         limit ${MAX_ORDERS_PER_TICK}`;
      let created = 0;
      for (const order of orders) {
        try {
          created += await this.assignment.assignOrderPickTasks({
            orgId: BigInt(order.org_id),
            orderInternalId: BigInt(order.order_id),
          });
        } catch (error) {
          this.logger.warn(
            `pick backfill failed for order ${order.order_id}: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      }
      if (created > 0) {
        this.logger.log(`pick backfill created ${created} task(s) for ${orders.length} order(s)`);
      }
    } catch (error) {
      this.logger.warn(
        `pick backfill tick failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
