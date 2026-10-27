/**
 * Label preview for an **unsaved** goods receipt
 * (`POST /goods-receipts/labels/preview`).
 *
 * The saved-receipt endpoint (`GET /inventory/receipts/:id/labels.svg`) can only
 * print after the receipt is posted; operators need the labels on the dock while
 * they are still counting. Both endpoints return the same SVG sheet produced by
 * the pure catalog label engine, so the print modal is identical.
 *
 * `label.read` is the permission the warehouse roles already hold for label
 * printing, and previewing writes nothing.
 */
import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { sendSvg } from '../../common/http/svg-response';
import { ReceiptLabelsPreviewBody, parseWith } from './dto/purchasing.dto';
import { PurchasingService } from './purchasing.service';

@ApiTags('purchasing')
@ApiBearerAuth()
@Controller('goods-receipts')
export class GoodsReceiptLabelsController {
  constructor(private readonly service: PurchasingService) {}

  @Post('labels/preview')
  @Permissions('label.read')
  @ApiOperation({ summary: 'Printable label sheet for a goods receipt that is not saved yet' })
  async preview(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const input = parseWith(ReceiptLabelsPreviewBody, body);
    const svg = await this.service.previewReceiptLabelsSvg(ctx, input);
    sendSvg(reply, svg, 'goods-receipt-labels-preview.svg');
  }
}
