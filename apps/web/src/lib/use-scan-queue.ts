import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api-client';
import { useOnlineStatus } from './hooks';
import {
  enqueueScan,
  flushScanQueue,
  loadScanQueue,
  type QueuedScan,
} from './scan-queue';

export interface ScanSubmissionResult {
  readonly outcome: 'sent' | 'queued';
}

/**
 * Offline-tolerant scan submission for station screens. When the network is
 * down (or the request fails at transport level) the scan is queued locally and
 * replayed with the same `eventId` once connectivity returns.
 */
export function useStationScans(): {
  readonly queuedCount: number;
  readonly online: boolean;
  submit: (endpoint: string, payload: Record<string, unknown>) => Promise<ScanSubmissionResult>;
  flush: () => Promise<number>;
} {
  const online = useOnlineStatus();
  const [queuedCount, setQueuedCount] = useState(() => loadScanQueue().length);

  const flush = useCallback(async (): Promise<number> => {
    const result = await flushScanQueue(async (endpoint, payload) => {
      await api.post(endpoint, payload);
    });
    setQueuedCount(result.remaining);
    return result.sent;
  }, []);

  useEffect(() => {
    if (online && queuedCount > 0) {
      void flush();
    }
  }, [online, queuedCount, flush]);

  const submit = useCallback(
    async (endpoint: string, payload: Record<string, unknown>): Promise<ScanSubmissionResult> => {
      if (!online) {
        enqueueScan(endpoint, payload);
        setQueuedCount(loadScanQueue().length);
        return { outcome: 'queued' };
      }
      try {
        await api.post(endpoint, payload);
        return { outcome: 'sent' };
      } catch (error) {
        if (error instanceof ApiError && error.isNetworkError) {
          enqueueScan(endpoint, payload);
          setQueuedCount(loadScanQueue().length);
          return { outcome: 'queued' };
        }
        throw error;
      }
    },
    [online],
  );

  return { queuedCount, online, submit, flush };
}

export type { QueuedScan };
