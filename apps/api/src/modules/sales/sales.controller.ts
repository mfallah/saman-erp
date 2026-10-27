/**
 * Sales HTTP surface (`API.md` §4.7). Thin controllers over `SalesService`;
 * every mutation has a permission decorator, audit action and (where required)
 * idempotency metadata.
 */
import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import type { TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { RequireStepUp } from '../../common/decorators/require-step-up.decorator';
import { ScopeCheck, ScopeResource } from '../../common/decorators/scope-check.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { parseIfMatch } from './sales.pg-support';
import { SalesService } from './sales.service';
import { AllocateOrderBody, CancelOrderBody, ConfirmOrderBody, CreateAddressBody, CreateCustomerBody, CreateInvoiceBody, CreateOrderBody, CreateRefundBody, CreateReturnBody, CustomerListQuery, CustomerLookupQuery, DeallocateOrderBody, HoldOrderBody, IdParam, InspectReturnBody, IssueInvoiceBody, OrderDetailQuery, OrderListQuery, PayRefundBody, ReceiveReturnBody, UpdateAddressBody, UpdateCreditBody, UpdateCustomerBody, UpdateOrderBody, VoidDocumentBody, parseWith } from './dto/sales.dto';

function offset(data: readonly unknown[], total: number, page: number, perPage: number) {
  return apiData(data, {
    pagination: { mode: 'offset', page, perPage, totalPages: Math.ceil(total / perPage), total },
    total,
  });
}

function cursor(data: readonly unknown[], limit: number) {
  return apiData(data, { pagination: { mode: 'cursor', limit, hasMore: data.length === limit } });
}

function versioned(reply: FastifyReply, data: Record<string, unknown>): Record<string, unknown> {
  const version = data['version'];
  if (typeof version === 'number') reply.header('ETag', `"${version}"`);
  return data;
}

function includeList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: SalesService) {}

  @Get()
  @Permissions('customer.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(CustomerListQuery, query);
    const result = await this.service.listCustomers(ctx, q);
    return offset(result.items, result.total, q.page, q.perPage);
  }

  @Post()
  @Permissions('customer.create')
  @Idempotent({ required: true })
  @Audited('customer.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createCustomer(ctx, parseWith(CreateCustomerBody, body)));
  }

  @Get('lookup')
  @Permissions('customer.read')
  async lookup(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    return apiData(await this.service.lookupCustomer(ctx, parseWith(CustomerLookupQuery, query)));
  }

  @Get(':id')
  @Permissions('customer.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Query() query: unknown) {
    const { id } = parseWith(IdParam, params);
    const q = parseWith(OrderDetailQuery, query);
    return apiData(await this.service.getCustomer(ctx, id, includeList(q.include)));
  }

  @Patch(':id')
  @Permissions('customer.update')
  @Audited('customer.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateCustomer(ctx, id, parseWith(UpdateCustomerBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('customer.delete')
  @HttpCode(204)
  @Audited('customer.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteCustomer(ctx, id);
  }

  @Get(':id/addresses')
  @Permissions('customer.read')
  async addresses(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.listAddresses(ctx, id));
  }

  @Post(':id/addresses')
  @Permissions('customer.update')
  @Idempotent()
  @Audited('customer.address_create')
  async addAddress(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.addAddress(ctx, id, parseWith(CreateAddressBody, body)));
  }

  @Patch(':id/addresses/:addressId')
  @Permissions('customer.update')
  @Audited('customer.address_update')
  async updateAddress(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { id } = parseWith(IdParam, params);
    const addressId = (params as { addressId: string }).addressId;
    return apiData(await this.service.updateAddress(ctx, id, addressId, parseWith(UpdateAddressBody, body)));
  }

  @Delete(':id/addresses/:addressId')
  @Permissions('customer.update')
  @HttpCode(204)
  @Audited('customer.address_delete')
  async deleteAddress(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteAddress(ctx, id, (params as { addressId: string }).addressId);
  }

  @Get(':id/credit')
  @Permissions('customer.credit.read')
  async credit(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getCredit(ctx, id));
  }

  @Patch(':id/credit')
  @RequireStepUp('customer.credit.update')
  @Permissions('customer.credit.update')
  @Audited('customer.credit_update')
  async updateCredit(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.updateCredit(ctx, id, parseWith(UpdateCreditBody, body)));
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@ScopeCheck('warehouseId')
@ScopeResource('sales_order')
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private readonly service: SalesService) {}

  @Get()
  @Permissions('sales.order.read')
  async list(@CurrentTenant() ctx: TenantContext, @Query() query: unknown) {
    const q = parseWith(OrderListQuery, query);
    const items = await this.service.listOrders(ctx, q);
    return cursor(items, q.limit);
  }

  @Post()
  @Permissions('sales.order.create')
  @Idempotent({ required: true })
  @Audited('sales.order.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createOrder(ctx, parseWith(CreateOrderBody, body)));
  }

  @Get(':id')
  @Permissions('sales.order.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getOrder(ctx, id));
  }

  @Patch(':id')
  @Permissions('sales.order.update')
  @Audited('sales.order.update')
  async update(
    @CurrentTenant() ctx: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { id } = parseWith(IdParam, params);
    const data = await this.service.updateOrder(ctx, id, parseWith(UpdateOrderBody, body), parseIfMatch(ifMatch));
    return apiData(versioned(reply, data));
  }

  @Delete(':id')
  @Permissions('sales.order.delete')
  @HttpCode(204)
  @Audited('sales.order.delete')
  async remove(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    await this.service.deleteOrder(ctx, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.submit')
  async submit(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.transitionAction(ctx, id, 'submit'));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.confirm')
  async confirm(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.confirmOrder(ctx, id, parseWith(ConfirmOrderBody, body)));
  }

  @Post(':id/allocate')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.allocate')
  async allocate(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.allocateOrder(ctx, id, parseWith(AllocateOrderBody, body)));
  }

  @Post(':id/deallocate')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.deallocate')
  async deallocate(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    const input = parseWith(DeallocateOrderBody, body);
    return apiData(await this.service.deallocateOrder(ctx, id, input.reason));
  }

  @Post(':id/hold')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.hold')
  async hold(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    const input = parseWith(HoldOrderBody, body);
    return apiData(await this.service.transitionAction(ctx, id, 'hold', input.reason));
  }

  @Post(':id/release')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.release')
  async release(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.transitionAction(ctx, id, 'release'));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Permissions('sales.order.update')
  @Audited('sales.order.cancel')
  async cancel(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.cancelOrder(ctx, id, parseWith(CancelOrderBody, body)));
  }

  @Get(':id/history')
  @Permissions('sales.order.read')
  async history(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    const order = await this.service.getOrder(ctx, id);
    return apiData(order['history'] ?? []);
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('customer-invoices')
export class InvoicesController {
  constructor(private readonly service: SalesService) {}

  @Post()
  @Permissions('customer.invoice.create')
  @Idempotent({ required: true })
  @Audited('customer.invoice.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createInvoice(ctx, parseWith(CreateInvoiceBody, body)));
  }

  @Get(':id')
  @Permissions('customer.invoice.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getInvoice(ctx, id));
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequireStepUp('customer.invoice.issue')
  @Permissions('customer.invoice.issue')
  @Audited('customer.invoice.issue')
  async issue(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.issueInvoice(ctx, id, parseWith(IssueInvoiceBody, body)));
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequireStepUp('customer.invoice.void')
  @Permissions('customer.invoice.void')
  @Audited('customer.invoice.void')
  async void(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.voidInvoice(ctx, id, parseWith(VoidDocumentBody, body).reason));
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('returns')
export class ReturnsController {
  constructor(private readonly service: SalesService) {}

  @Post()
  @Permissions('sales.return.create')
  @Idempotent({ required: true })
  @Audited('sales.return.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createReturn(ctx, parseWith(CreateReturnBody, body)));
  }

  @Get(':id')
  @Permissions('sales.return.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getReturn(ctx, id));
  }

  @Post(':id/receive')
  @HttpCode(200)
  @Permissions('sales.return.update')
  @Audited('sales.return.receive')
  async receive(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.receiveReturn(ctx, id, parseWith(ReceiveReturnBody, body)));
  }

  @Post(':id/inspect')
  @HttpCode(200)
  @Permissions('sales.return.update')
  @Audited('sales.return.inspect')
  async inspect(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.inspectReturn(ctx, id, parseWith(InspectReturnBody, body)));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireStepUp('sales.return.approve')
  @Permissions('sales.return.approve')
  @Audited('sales.return.approve')
  async approve(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.approveReturn(ctx, id));
  }

  @Post(':id/close')
  @HttpCode(200)
  @Permissions('sales.return.update')
  @Audited('sales.return.close')
  async close(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.closeReturn(ctx, id));
  }
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('refunds')
export class RefundsController {
  constructor(private readonly service: SalesService) {}

  @Post()
  @Permissions('sales.refund.create')
  @Idempotent({ required: true })
  @Audited('sales.refund.create')
  async create(@CurrentTenant() ctx: TenantContext, @Body() body: unknown) {
    return apiData(await this.service.createRefund(ctx, parseWith(CreateRefundBody, body)));
  }

  @Get(':id')
  @Permissions('sales.refund.read')
  async detail(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.getRefund(ctx, id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireStepUp('sales.refund.approve')
  @Permissions('sales.refund.approve')
  @Audited('sales.refund.approve')
  async approve(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.approveRefund(ctx, id));
  }

  @Post(':id/pay')
  @HttpCode(200)
  @RequireStepUp('sales.refund.pay')
  @Permissions('sales.refund.pay')
  @Audited('sales.refund.pay')
  async pay(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    parseWith(PayRefundBody, body);
    return apiData(await this.service.payRefund(ctx, id));
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequireStepUp('sales.refund.void')
  @Permissions('sales.refund.void')
  @Audited('sales.refund.void')
  async void(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id } = parseWith(IdParam, params);
    return apiData(await this.service.voidRefund(ctx, id, parseWith(VoidDocumentBody, body).reason));
  }
}
