import { BadRequestException, Body, Controller, Delete, Inject, NotFoundException, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { DB, type Db, type TenantContext } from '../../common/contracts';
import { CurrentTenant } from '../../common/decorators/current-context.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Audited } from '../../common/decorators/audited.decorator';
import { apiData } from '../../common/interceptors/response.interceptor';
import { IdParam, parseWith } from './dto/warehouse.dto';

export const LEVELS = ['zone', 'aisle', 'rack', 'shelf', 'bin', 'location'] as const;
type Level = (typeof LEVELS)[number];

const NodeParams = IdParam.extend({
  level: z.enum(LEVELS),
  nodeId: z.string().uuid(),
});

const UpdateNodeBody = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    code: z.string().trim().min(1).max(20).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });

/**
 * Rename or remove a hierarchy node (zone / aisle / rack / shelf / bin /
 * location). Removal is refused while the node still has children or stock, so
 * the warehouse tree can never lose the address of inventory.
 */
@ApiTags('warehouse')
@ApiBearerAuth()
@Controller('warehouses')
export class WarehouseTreeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Patch(':id/tree/:level/:nodeId')
  @Permissions('warehouse.location.update')
  @Audited('warehouse.location.update')
  @ApiOperation({ summary: 'Rename a warehouse hierarchy node' })
  async updateNode(@CurrentTenant() ctx: TenantContext, @Param() params: unknown, @Body() body: unknown) {
    const { id, level, nodeId } = parseWith(NodeParams, params);
    const input = parseWith(UpdateNodeBody, body);
    const sql = this.db as unknown as Raw;
    const code = input.code ?? null;
    const name = input.name ?? null;
    let rows: Record<string, unknown>[] = [];
    switch (level) {
      case 'zone':
        rows = await sql`update erp.warehouse_zones t set code = coalesce(${code}, t.code), name = coalesce(${name}, t.name)
          from erp.warehouses w where t.public_id = ${nodeId}::uuid and w.id = t.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'aisle':
        rows = await sql`update erp.warehouse_aisles t set code = coalesce(${code}, t.code), name = coalesce(${name}, t.name)
          from erp.warehouse_zones z join erp.warehouses w on w.id = z.warehouse_id
          where t.public_id = ${nodeId}::uuid and z.id = t.zone_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'rack':
        rows = await sql`update erp.warehouse_racks t set code = coalesce(${code}, t.code), name = coalesce(${name}, t.name)
          from erp.warehouse_aisles a join erp.warehouse_zones z on z.id = a.zone_id join erp.warehouses w on w.id = z.warehouse_id
          where t.public_id = ${nodeId}::uuid and a.id = t.aisle_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'shelf':
        rows = await sql`update erp.warehouse_shelves t set code = coalesce(${code}, t.code)
          from erp.warehouse_racks r join erp.warehouse_aisles a on a.id = r.aisle_id join erp.warehouse_zones z on z.id = a.zone_id
          join erp.warehouses w on w.id = z.warehouse_id
          where t.public_id = ${nodeId}::uuid and r.id = t.rack_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'bin':
        rows = await sql`update erp.warehouse_bins t set code = coalesce(${code}, t.code)
          from erp.warehouse_shelves s join erp.warehouse_racks r on r.id = s.rack_id join erp.warehouse_aisles a on a.id = r.aisle_id
          join erp.warehouse_zones z on z.id = a.zone_id join erp.warehouses w on w.id = z.warehouse_id
          where t.public_id = ${nodeId}::uuid and s.id = t.shelf_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      default:
        rows = await sql`update erp.warehouse_locations t set full_code = coalesce(${code}, t.full_code), updated_at = now(), version = version + 1
          from erp.warehouses w where t.public_id = ${nodeId}::uuid and w.id = t.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
    }
    if (rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND', message: 'node not found' });
    return apiData({ id: nodeId, level });
  }

  @Delete(':id/tree/:level/:nodeId')
  @Permissions('warehouse.location.delete')
  @Audited('warehouse.location.delete')
  @ApiOperation({ summary: 'Delete an empty warehouse hierarchy node' })
  async deleteNode(@CurrentTenant() ctx: TenantContext, @Param() params: unknown) {
    const { id, level, nodeId } = parseWith(NodeParams, params);
    const sql = this.db as unknown as Raw;
    if (level === 'location') {
      const stocked = await sql`
        select count(*)::int as n
          from erp.inventory_balances b
          join erp.warehouse_locations l on l.id = b.location_id
          join erp.warehouses w on w.id = l.warehouse_id
         where l.public_id = ${nodeId}::uuid and w.public_id = ${id}::uuid
           and (b.on_hand <> 0 or b.reserved <> 0)`;
      if (Number(stocked[0]?.['n'] ?? 0) > 0) {
        throw new BadRequestException({ code: 'RULE_VIOLATION', message: 'این موقعیت موجودی دارد و حذف نمی‌شود.' });
      }
      const rows = await sql`update erp.warehouse_locations l set deleted_at = now(), is_active = false, updated_at = now()
        from erp.warehouses w where l.public_id = ${nodeId}::uuid and w.id = l.warehouse_id
        and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} and l.deleted_at is null
        returning l.id::text as id`;
      if (rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND', message: 'location not found' });
      return apiData({ id: nodeId, level, deleted: true });
    }
    const children = await sql`
      select (
        case ${level}
          when 'zone' then (select count(*) from erp.warehouse_aisles c join erp.warehouse_zones p on p.id = c.zone_id where p.public_id = ${nodeId}::uuid)
          when 'aisle' then (select count(*) from erp.warehouse_racks c join erp.warehouse_aisles p on p.id = c.aisle_id where p.public_id = ${nodeId}::uuid)
          when 'rack' then (select count(*) from erp.warehouse_shelves c join erp.warehouse_racks p on p.id = c.rack_id where p.public_id = ${nodeId}::uuid)
          when 'shelf' then (select count(*) from erp.warehouse_bins c join erp.warehouse_shelves p on p.id = c.shelf_id where p.public_id = ${nodeId}::uuid)
          when 'bin' then (select count(*) from erp.warehouse_locations c join erp.warehouse_bins p on p.id = c.bin_id where p.public_id = ${nodeId}::uuid and c.deleted_at is null)
          else 0 end
      )::int as children`;
    if (Number(children[0]?.['children'] ?? 0) > 0) {
      throw new BadRequestException({ code: 'RULE_VIOLATION', message: 'این نود زیرمجموعه دارد؛ ابتدا زیرمجموعه‌ها را حذف کنید.' });
    }
    let rows: Record<string, unknown>[] = [];
    switch (level) {
      case 'zone':
        rows = await sql`delete from erp.warehouse_zones t using erp.warehouses w
          where t.public_id = ${nodeId}::uuid and w.id = t.warehouse_id and w.public_id = ${id}::uuid
          and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'aisle':
        rows = await sql`delete from erp.warehouse_aisles t using erp.warehouse_zones z, erp.warehouses w
          where t.public_id = ${nodeId}::uuid and z.id = t.zone_id and w.id = z.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'rack':
        rows = await sql`delete from erp.warehouse_racks t using erp.warehouse_aisles a, erp.warehouse_zones z, erp.warehouses w
          where t.public_id = ${nodeId}::uuid and a.id = t.aisle_id and z.id = a.zone_id and w.id = z.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      case 'shelf':
        rows = await sql`delete from erp.warehouse_shelves t using erp.warehouse_racks r, erp.warehouse_aisles a, erp.warehouse_zones z, erp.warehouses w
          where t.public_id = ${nodeId}::uuid and r.id = t.rack_id and a.id = r.aisle_id and z.id = a.zone_id and w.id = z.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
      default:
        rows = await sql`delete from erp.warehouse_bins t using erp.warehouse_shelves s, erp.warehouse_racks r, erp.warehouse_aisles a, erp.warehouse_zones z, erp.warehouses w
          where t.public_id = ${nodeId}::uuid and s.id = t.shelf_id and r.id = s.rack_id and a.id = r.aisle_id and z.id = a.zone_id and w.id = z.warehouse_id
          and w.public_id = ${id}::uuid and w.organization_id = ${ctx.orgId} returning t.id::text as id`;
        break;
    }
    if (rows.length === 0) throw new NotFoundException({ code: 'NOT_FOUND', message: 'node not found' });
    return apiData({ id: nodeId, level, deleted: true });
  }
}

type Raw = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
