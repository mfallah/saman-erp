/** Reporting DTOs (Zod). */
import { z } from 'zod';
import { appErrorFromZod } from '@saman/shared';
import type { ZodType } from 'zod';

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'iso_date' });

export const RunReportSchema = z.object({
  params: z.object({
    from: IsoDate,
    to: IsoDate,
    calendar: z.enum(['gregorian', 'jalali']).optional(),
    filters: z.record(z.unknown()).optional(),
  }),
  async: z.boolean().optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).optional(),
});

export const CreateDefinitionSchema = z.object({
  code: z.string().min(3).max(80),
  titleFa: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
  queryTemplateId: z.string().min(1).max(80),
  requiredPermissions: z.array(z.string().max(120)).max(20).optional(),
});

export const CreateExportSchema = z.object({
  entity: z.enum([
    'products',
    'inventory',
    'inventory-ledger',
    'orders',
    'customers',
    'suppliers',
    'journal',
    'ledger',
    'trial-balance',
    'payments',
    'cheques',
    'partners',
    'audit',
  ]),
  format: z.enum(['csv', 'xlsx']),
  filters: z.record(z.unknown()).optional(),
  columns: z.array(z.string().max(80)).max(200).optional(),
});

export function parseDto<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw appErrorFromZod(result.error);
  return result.data;
}

export function toBigInt(value: string | number): bigint {
  return typeof value === 'number' ? BigInt(value) : BigInt(value);
}
