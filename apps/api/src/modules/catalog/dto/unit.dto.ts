/**
 * Unit of measure & conversion contracts (`API.md` §4.3 units, `DATA-MODEL` §2.4
 * `catalog.units_of_measure` / `unit_conversions`).
 */
import { RateString } from '@saman/shared';
import { z } from 'zod';

import { CatalogListBase, PublicId, UomDimension } from './common';

export const CreateUnitBody = z
  .object({
    nameFa: z.string().trim().min(1).max(80),
    nameEn: z.string().trim().max(80).optional(),
    code: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/, { message: 'invalid_unit_code' }),
    symbol: z.string().trim().min(1).max(20),
    type: UomDimension,
    isBase: z.boolean().default(false),
    precision: z.number().int().min(0).max(4).optional(),
  })
  .refine((body) => body.type !== 'count' || undefined === body.precision || body.precision === 0, {
    message: 'count_unit_requires_zero_precision',
    path: ['precision'],
  });
export type CreateUnitBody = z.infer<typeof CreateUnitBody>;

export const UpdateUnitBody = z
  .object({
    nameFa: z.string().trim().min(1).max(80).optional(),
    nameEn: z.string().trim().max(80).optional(),
    symbol: z.string().trim().min(1).max(20).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateUnitBody = z.infer<typeof UpdateUnitBody>;

/**
 * A conversion factor is a positive decimal string (`numeric(30,12)`).
 * `RateString` enforces the decimal-string transport rule; positivity and the
 * reciprocal-pair rule are enforced by the domain engine.
 */
export const CreateConversionBody = z.object({
  toUnitId: PublicId,
  factor: RateString.refine((value) => Number(value) > 0, { message: 'factor_must_be_positive' }),
  rounding: z.enum(['half_up', 'half_even', 'down', 'up']).optional(),
});
export type CreateConversionBody = z.infer<typeof CreateConversionBody>;

export const UnitListQuery = CatalogListBase.extend({
  type: UomDimension.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type UnitListQuery = z.infer<typeof UnitListQuery>;

export const UnitDetailQuery = z.object({
  include: z.string().trim().max(200).optional(),
});
export type UnitDetailQuery = z.infer<typeof UnitDetailQuery>;

export const ConversionIdParam = z.object({ id: PublicId, conversionId: PublicId });
export type ConversionIdParam = z.infer<typeof ConversionIdParam>;
