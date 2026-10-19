/**
 * Offline scan queue for warehouse stations (ADR-0011).
 *
 * Hardware scanners and phones lose connectivity on the warehouse floor; scan
 * events are queued in localStorage (never tokens) and replayed with the
 * client-generated `eventId`, which the API treats as an idempotency key.
 */
const STORAGE_KEY = 'saman.scan-queue.v1';

export interface QueuedScan {
  readonly eventId: string;
  readonly endpoint: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export type ScanSender = (
  endpoint: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

function isQueuedScan(value: unknown): value is QueuedScan {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['eventId'] === 'string' &&
    typeof candidate['endpoint'] === 'string' &&
    typeof candidate['payload'] === 'object' &&
    candidate['payload'] !== null &&
    typeof candidate['createdAt'] === 'string'
  );
}

export function loadScanQueue(): readonly QueuedScan[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isQueuedScan) : [];
  } catch {
    return [];
  }
}

function persist(queue: readonly QueuedScan[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage unavailable; the in-memory caller still has its own state.
  }
}

export function enqueueScan(
  endpoint: string,
  payload: Record<string, unknown>,
): readonly QueuedScan[] {
  const queue = loadScanQueue();
  if (queue.some((item) => item.eventId === payload['eventId'])) {
    return queue;
  }
  const next: QueuedScan[] = [
    ...queue,
    {
      eventId: String(payload['eventId'] ?? ''),
      endpoint,
      payload,
      createdAt: new Date().toISOString(),
    },
  ];
  persist(next);
  return next;
}

/**
 * Replays queued scans in order. Stops at the first still-unreachable event so
 * ordering is preserved; permission/domain errors are dropped (they will never
 * succeed) and reported back through `onRejected`.
 */
export async function flushScanQueue(
  send: ScanSender,
  onRejected?: (scan: QueuedScan, error: unknown) => void,
): Promise<{ sent: number; remaining: number }> {
  const queue = loadScanQueue();
  let sent = 0;
  const remaining: QueuedScan[] = [];
  for (const scan of queue) {
    try {
      await send(scan.endpoint, scan.payload);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('NETWORK') || message.includes('ارتباط با سرور')) {
        remaining.push(scan);
      } else {
        onRejected?.(scan, error);
      }
    }
  }
  persist(remaining);
  return { sent, remaining: remaining.length };
}

export function clearScanQueue(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
