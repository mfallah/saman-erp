/**
 * Pick-task auto-assignment for materialised channel orders.
 *
 * One task per order line, spread round-robin over the organization's active
 * warehouse pickers (RBAC: `warehouse.pick`), capped at `PICK_TASK_CAPACITY`
 * open tasks per picker. The outbox worker reaches this through the
 * `PickAssignmentPort` seam instead of importing Nest providers.
 */
import { Inject, Injectable } from '@nestjs/common';

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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: WarehouseRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Returns the number of tasks created (0 when the order has no warehouse/lines). */
  async assignOrderPickTasks(input: { orgId: bigint; orderInternalId: bigint }): Promise<number> {
    return this.db.begin(async (tx) => {
      const warehouseInternalId = await this.repo.findOrderWarehouse(tx, input.orgId, input.orderInternalId);
      if (warehouseInternalId === null) return 0;

      const lines = await this.repo.listUnpickedOrderLines(tx, input.orderInternalId);
      if (lines.length === 0) return 0;

      const pickers = await this.repo.listActivePickers(tx, input.orgId);
      const capacity = this.config.pickTaskCapacity;
      const load = pickers.map((picker) => picker.openTasks);
      let cursor = 0;
      // Round-robin: continue after the last picker used, skipping anyone at capacity.
      const nextPicker = (): bigint | null => {
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
      for (const [index, line] of lines.entries()) {
        const locationInternalId = await this.repo.findPickLocationForVariant(
          tx,
          warehouseInternalId,
          line.variantInternalId,
        );
        if (locationInternalId === null) continue;
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
      return created;
    });
  }
}
