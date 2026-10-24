/**
 * Goods-receipt label sheet (`GET /inventory/receipts/:receiptId/labels.svg`).
 *
 * The URL is inventory-scoped because labels are printed while receiving stock,
 * but the document is owned by purchasing — the only module that reads goods
 * receipts. Rendering stays in the pure catalog label engine, reached through
 * `PurchasingService`; this class only parses, authorizes and streams the SVG.
 */
import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { sendSvg } from '../../common/http/svg-response';
import { ReceiptLabelsParam, ReceiptLabelsQuery, parseWith } from './dto/purchasing.dto';
import { PurchasingService } from './purchasing.service';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('inventory/receipts')
export class ReceiptLabelsController {
  constructor(private readonly service: PurchasingService) {}

  @Get(':receiptId/labels.svg')
  @Permissions('purchase.order.read')
  @ApiOperation({ summary: 'Printable label sheet for a goods receipt (one label per unit/serial)' })
  async labels(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { receiptId } = parseWith(ReceiptLabelsParam, params);
    const { copies } = parseWith(ReceiptLabelsQuery, query);
    const svg = await this.service.receiptLabelsSvg(ctx, receiptId, copies);
    sendSvg(reply, svg, `receipt-${receiptId}-labels.svg`);
  }
}
