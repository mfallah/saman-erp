/**
 * Pick-task auto-assignment for materialised channel orders.
 *
 * One task per order line, spread round-robin over the organization's active
 * warehouse pickers (RBAC: `warehouse.pick`), capped at `PICK_TASK_CAPACITY`
 * open tasks per picker. The outbox worker reaches this through the
 * `PickAssignmentPort` seam instead of importing Nest providers.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { DB } from '../../common/contracts';
import { APP_CONFIG, type AppConfig } from '../../config/env.schema';
import type { Db } from './warehouse.pg-support';
import { WarehouseRepository } from './warehouse.repository';

/** Port consumed by `workers/outbox-handlers.ts`. */
export interface PickAssignmentPort {
  assignOrderPickTasks(input: { orgId: bigint; orderInternalId: bigint }): Promise<number>;
}

@Injectable()
export class PickAssignmentService implements PickAssignmentPort {
  private readonly logger = new Logger(PickAssignmentService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: WarehouseRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Returns the number of tasks created (0 when the order has no warehouse/lines). */
  async assignOrderPickTasks(input: { orgId: bigint; orderInternalId: bigint }): Promise<number> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId = await this.repo.findOrderWarehouse(tx, input.orgId, input.orderInternalId);
      if (warehouseInternalId === null) {
        this.logger.warn(
          `no warehouse resolved for order ${input.orderInternalId.toString()} (org ${input.orgId.toString()}); pick tasks not created`,
        );
        return 0;
      }

      const lines = await this.repo.listUnpickedOrderLines(tx, input.orderInternalId);
      if (lines.length === 0) {
        this.logger.log(
          `order ${input.orderInternalId.toString()} has no unpicked lines; pick tasks not created`,
        );
        return 0;
      }

      const { pickers, fallback } = await this.resolvePickers(tx, input);
      const capacity = this.config.pickTaskCapacity;
      const load = pickers.map((picker) => picker.openTasks);
      let cursor = 0;
      // Round-robin: continue after the last picker used, skipping anyone at capacity.
      const nextPicker = (): bigint | null => {
        if (pickers.length === 0) return null;
        for (let attempt = 0; attempt < pickers.length; attempt += 1) {
          const index = (cursor + attempt) % pickers.length;
          const open = load[index] ?? 0;
          if (open < capacity) {
            load[index] = open + 1;
            const picker = pickers[index];
            cursor = (index + 1) % pickers.length;
            return picker === undefined ? null : BigInt(picker.id);
          }
        }
        return null;
      };

      let created = 0;
      let skippedNoLocation = 0;
      for (const [index, line] of lines.entries()) {
        const locationInternalId = await this.repo.findPickLocationForVariant(
          tx,
          warehouseInternalId,
          line.variantInternalId,
        );
        if (locationInternalId === null) {
          skippedNoLocation += 1;
          continue;
        }
        await this.repo.insertOrderPickTask(tx, {
          orderInternalId: input.orderInternalId,
          lineInternalId: line.id,
          variantInternalId: line.variantInternalId,
          locationInternalId,
          quantity: line.quantity,
          sequenceNo: index + 1,
          assignedTo: nextPicker(),
        });
        created += 1;
      }
      if (skippedNoLocation > 0) {
        this.logger.warn(
          `order ${input.orderInternalId.toString()}: ${skippedNoLocation.toString()} line(s) skipped without a pickable location in warehouse ${warehouseInternalId}`,
        );
      }
      this.logger.log(
        `order ${input.orderInternalId.toString()}: ${created.toString()}/${lines.length.toString()} pick tasks created, ${pickers.length.toString()} ${fallback ? 'fallback' : 'warehouse.pick'} picker(s)`,
      );
      return created;
    });
  }

  /**
   * Preferred pool: active users holding `warehouse.pick`. When nobody holds it
   * (unseeded permission, fresh organization) fall back to active users with the
   * warehouse/admin role so the board is never unusable; log why.
   */
  private async resolvePickers(
    tx: Db,
    input: { orgId: bigint; orderInternalId: bigint },
  ): Promise<{ pickers: { id: string; openTasks: number }[]; fallback: boolean }> {
    const pickers = await this.repo.listActivePickers(tx, input.orgId);
    if (pickers.length > 0) return { pickers, fallback: false };
    const fallback = await this.repo.listFallbackPickers(tx, input.orgId);
    if (fallback.length > 0) {
      this.logger.warn(
        `no active user holds warehouse.pick in org ${input.orgId.toString()}; falling back to ${fallback.length.toString()} warehouse/admin user(s) for order ${input.orderInternalId.toString()}`,
      );
      return { pickers: fallback, fallback: true };
    }
    this.logger.error(
      `no assignable picker in org ${input.orgId.toString()}: no active user holds warehouse.pick and no active warehouse/admin user exists; order ${input.orderInternalId.toString()} tasks will be unassigned`,
    );
    return { pickers: [], fallback: false };
  }
}
