/**
 * Shared catalog request contracts: path params, query schemas and the Zod
 * validation helper used by the controller (`API.md` §1.5/§1.6/§1.9).
 */
import { OffsetPaginationQuery, appErrorFromZod } from '@saman/shared';
import { z, type ZodTypeAny } from 'zod';

export const PublicId = z.string().uuid({ message: 'invalid_uuid' });

export const IdParam = z.object({ id: PublicId });

/** Parses an untrusted value with a Zod schema; failures map to `VALIDATION_ERROR`. */
export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw appErrorFromZod(result.error);
  }
  return result.data as z.infer<S>;
}

/** `?flag=true|false` — never `z.coerce.boolean()` (string "false" is truthy). */
export const BooleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const ProductStatus = z.enum(['draft', 'active', 'inactive', 'discontinued']);
export const EntityStatus = z.enum(['active', 'inactive']);
export const AttributeDataType = z.enum(['text', 'number', 'boolean', 'enum', 'date', 'color']);
export const UomDimension = z.enum(['count', 'mass', 'volume', 'length', 'area', 'time', 'package']);
export const BarcodeType = z.enum(['ean13', 'ean8', 'upc', 'code128', 'code39', 'qr', 'internal']);
export const BarcodeSource = z.enum(['manufacturer', 'internal', 'channel', 'supplier']);

export const EmptyObject = z.object({}).strict();

/** Offset list base for small catalog admin lists. */
export const CatalogListBase = OffsetPaginationQuery;

export type IdParam = z.infer<typeof IdParam>;
