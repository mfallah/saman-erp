/** Worker lifecycle: starts the outbox loop, stops everything gracefully. */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import type { AppLogger } from '../modules/channels/ports/logger.port';
import { LOGGER } from '../modules/channels/ports/logger.port';
import { OutboxDispatcher } from './queue/outbox.dispatcher';

@Injectable()
export class WorkerRuntime implements OnModuleDestroy {
  private stopping = false;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async start(): Promise<void> {
    await this.dispatcher.start();
    this.logger.info(
      { pid: process.pid, handlers: this.dispatcher.handlerCount },
      'worker runtime started',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info({ pid: process.pid }, 'worker runtime stopping: draining outbox');
    await this.dispatcher.stop();
  }
}
