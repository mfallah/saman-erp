/** Warehouse domain events (`ARCHITECTURE.md` §7). */
export const WAREHOUSE_EVENTS = {
  warehouseCreated: 'warehouse.warehouse.created',
  warehouseUpdated: 'warehouse.warehouse.updated',
  locationCreated: 'warehouse.location.created',
  locationMoved: 'warehouse.location.moved',
  putawayTaskCreated: 'warehouse.putaway.task_created',
  putawayCompleted: 'warehouse.putaway.completed',
  waveCreated: 'warehouse.wave.created',
  waveReleased: 'warehouse.wave.released',
  waveCancelled: 'warehouse.wave.cancelled',
  pickTaskAssigned: 'warehouse.pick.task_assigned',
  pickTaskStarted: 'warehouse.pick.started',
  pickScanAccepted: 'warehouse.pick.scan_accepted',
  pickTaskCompleted: 'warehouse.pick.completed',
  pickTaskShort: 'warehouse.pick.short',
  packTaskCreated: 'warehouse.pack.task_created',
  packTaskStarted: 'warehouse.pack.started',
  packTaskCompleted: 'warehouse.pack.completed',
} as const;

export type WarehouseEventType = (typeof WAREHOUSE_EVENTS)[keyof typeof WAREHOUSE_EVENTS];

export interface WaveEventPayload {
  readonly waveId: string;
  readonly waveNo: string;
  readonly warehouseId: string;
  readonly status: string;
  readonly orderCount: number;
  readonly taskCount: number;
}

export interface PickTaskEventPayload {
  readonly taskId: string;
  readonly waveId: string | null;
  readonly orderId: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly quantityRequired: string;
  readonly quantityPicked: string;
  readonly status: string;
}

export interface ScanEventPayload {
  readonly taskId: string;
  readonly barcode: string;
  readonly quantity: string;
  readonly result: string;
}
