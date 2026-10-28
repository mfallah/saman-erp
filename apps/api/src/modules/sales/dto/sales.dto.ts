/**
 * Sales request contracts (`API.md` §4.7).
 */
import { MoneyString, PercentString, QuantityString, appErrorFromZod } from '@saman/shared';
import { z, type ZodTypeAny } from 'zod';

export const PublicId = z.string().uuid({ message: 'invalid_uuid' });
export const IdParam = z.object({ id: PublicId });

export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw appErrorFromZod(result.error);
  }
  return result.data as z.infer<S>;
}

export const PositiveQuantity = QuantityString.refine((value) => Number(value) > 0, {
  message: 'quantity_must_be_positive',
});

export const CustomerListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().min(2).max(100).optional(),
  mobile: z.string().trim().max(20).optional(),
  status: z.enum(['active', 'inactive', 'blocked']).optional(),
  groupId: PublicId.optional(),
});
export type CustomerListQuery = z.infer<typeof CustomerListQuery>;

export const CreateCustomerBody = z.object({
  fullName: z.string().trim().min(2).max(250),
  mobile: z.string().trim().regex(/^09\d{9}$/, { message: 'invalid_mobile' }).optional(),
  email: z.string().trim().email().max(255).optional(),
  nationalId: z.string().trim().regex(/^\d{10}$/, { message: 'invalid_national_id' }).optional(),
  customerType: z.enum(['retail', 'wholesale', 'vip', 'corporate']).optional(),
  creditLimit: MoneyString.optional(),
  paymentTermDays: z.number().int().min(0).max(3650).optional(),
  notes: z.string().trim().max(2000).optional(),
  addresses: z
    .array(
      z.object({
        title: z.string().trim().max(50).optional(),
        province: z.string().trim().max(100),
        city: z.string().trim().max(100),
        postalCode: z.string().trim().max(20).optional(),
        line1: z.string().trim().min(3).max(500),
        line2: z.string().trim().max(500).optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .max(10)
    .optional(),
});
export type CreateCustomerBody = z.infer<typeof CreateCustomerBody>;

export const UpdateCustomerBody = z
  .object({
    fullName: z.string().trim().min(2).max(250).optional(),
    email: z.string().trim().email().max(255).optional(),
    status: z.enum(['active', 'inactive', 'blocked']).optional(),
    notes: z.string().trim().max(2000).optional(),
    customerType: z.enum(['retail', 'wholesale', 'vip', 'corporate']).optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateCustomerBody = z.infer<typeof UpdateCustomerBody>;

export const CustomerLookupQuery = z
  .object({
    mobile: z.string().trim().max(20).optional(),
    email: z.string().trim().max(255).optional(),
    nationalId: z.string().trim().max(20).optional(),
  })
  .refine((query) => query.mobile !== undefined || query.email !== undefined || query.nationalId !== undefined, {
    message: 'lookup_key_required',
  });
export type CustomerLookupQuery = z.infer<typeof CustomerLookupQuery>;

export const CreateAddressBody = z.object({
  title: z.string().trim().max(50).optional(),
  type: z.enum(['shipping', 'billing', 'both']).optional(),
  receiverName: z.string().trim().max(200).optional(),
  receiverMobile: z.string().trim().max(20).optional(),
  province: z.string().trim().max(100),
  city: z.string().trim().max(100),
  district: z.string().trim().max(100).optional(),
  line1: z.string().trim().min(3).max(500),
  line2: z.string().trim().max(500).optional(),
  postalCode: z.string().trim().max(20).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  isDefault: z.boolean().optional(),
});
export type CreateAddressBody = z.infer<typeof CreateAddressBody>;

export const UpdateAddressBody = z
  .object({
    title: z.string().trim().max(50).optional(),
    receiverName: z.string().trim().max(200).optional(),
    receiverMobile: z.string().trim().max(20).optional(),
    province: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    line1: z.string().trim().min(3).max(500).optional(),
    postalCode: z.string().trim().max(20).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateAddressBody = z.infer<typeof UpdateAddressBody>;

export const UpdateCreditBody = z.object({
  creditLimit: MoneyString,
  termDays: z.number().int().min(0).max(3650).optional(),
  note: z.string().trim().max(300).optional(),
});
export type UpdateCreditBody = z.infer<typeof UpdateCreditBody>;

export const OrderLineInput = z.object({
  variantId: PublicId,
  quantity: PositiveQuantity,
  unitPrice: MoneyString,
  discount: MoneyString.optional(),
  taxPercent: PercentString.optional(),
  taxRateId: PublicId.optional(),
});
export type OrderLineInput = z.infer<typeof OrderLineInput>;

export const OrderListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z
    .enum([
      'draft',
      'pending',
      'submitted',
      'confirmed',
      'allocated',
      'picking',
      'packed',
      'shipped',
      'delivered',
      'returned',
      'closed',
      'cancelled',
      'on_hold',
    ])
    .optional(),
  /**
   * The default list is the *working* list: shipped/delivered/cancelled/closed
   * orders are excluded (they live in history). `?includeClosed=true` returns
   * everything, and an explicit `status` filter always wins over this default.
   */
  includeClosed: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  channelCode: z.string().trim().max(40).optional(),
  customerId: PublicId.optional(),
  warehouseId: PublicId.optional(),
  createdAtGte: z.string().datetime().optional(),
  orderDateGte: z.string().datetime().optional(),
  q: z.string().trim().min(2).max(100).optional(),
});
export type OrderListQuery = z.infer<typeof OrderListQuery>;

export const CreateOrderBody = z.object({
  customerId: PublicId,
  channelCode: z.string().trim().max(40).optional(),
  warehouseId: PublicId.optional(),
  lines: z.array(OrderLineInput).min(1).max(200),
  shippingAddressId: PublicId.optional(),
  discount: MoneyString.optional(),
  shippingAmount: MoneyString.optional(),
  customerNote: z.string().trim().max(2000).optional(),
  autoConfirm: z.boolean().optional(),
});
export type CreateOrderBody = z.infer<typeof CreateOrderBody>;

export const UpdateOrderBody = z
  .object({
    lines: z.array(OrderLineInput).min(1).max(200).optional(),
    discount: MoneyString.optional(),
    shippingAmount: MoneyString.optional(),
    customerNote: z.string().trim().max(2000).optional(),
    warehouseId: PublicId.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'empty_update' });
export type UpdateOrderBody = z.infer<typeof UpdateOrderBody>;

export const ConfirmOrderBody = z.object({ partialFulfilmentAllowed: z.boolean().optional() });
export type ConfirmOrderBody = z.infer<typeof ConfirmOrderBody>;
export const AllocateOrderBody = z.object({
  strategy: z.enum(['single_warehouse_first', 'split_fewest_locations', 'fifo']).optional(),
});
export const HoldOrderBody = z.object({ reason: z.string().trim().min(2).max(300) });
export const CancelOrderBody = z.object({
  reason: z.string().trim().min(2).max(300),
  restock: z.boolean().optional(),
});
export type CancelOrderBody = z.infer<typeof CancelOrderBody>;
export const DeallocateOrderBody = z.object({ reason: z.string().trim().min(2).max(300) });

export const OrderDetailQuery = z.object({ include: z.string().trim().max(300).optional() });

export const InvoiceListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z.enum(['draft', 'issued', 'partially_paid', 'paid', 'voided']).optional(),
  customerId: PublicId.optional(),
  orderId: PublicId.optional(),
  issueDateGte: z.string().date().optional(),
});
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>;

export const CreateInvoiceBody = z.object({
  orderId: PublicId.optional(),
  returnId: PublicId.optional(),
  customerId: PublicId,
  lines: z
    .array(
      z.object({
        variantId: PublicId,
        quantity: PositiveQuantity,
        unitPrice: MoneyString,
        discount: MoneyString.optional(),
        taxPercent: PercentString.optional(),
      }),
    )
    .min(1)
    .max(200)
    .optional(),
  issueDate: z.string().date().optional(),
});
export type CreateInvoiceBody = z.infer<typeof CreateInvoiceBody>;

export const IssueInvoiceBody = z.object({ issueDate: z.string().date().optional() });
export type IssueInvoiceBody = z.infer<typeof IssueInvoiceBody>;
export const VoidDocumentBody = z.object({ reason: z.string().trim().min(2).max(300) });

export const ReturnListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z.enum(['requested', 'approved', 'rejected', 'received', 'inspected', 'completed', 'cancelled']).optional(),
  orderId: PublicId.optional(),
  customerId: PublicId.optional(),
});
export type ReturnListQuery = z.infer<typeof ReturnListQuery>;

export const CreateReturnBody = z.object({
  orderId: PublicId,
  lines: z
    .array(
      z.object({
        orderLineId: PublicId,
        quantity: PositiveQuantity,
        reason: z.string().trim().min(2).max(300),
      }),
    )
    .min(1)
    .max(200),
  resolution: z.enum(['refund', 'exchange', 'credit']).default('refund'),
  attachmentFileIds: z.array(PublicId).max(20).optional(),
});
export type CreateReturnBody = z.infer<typeof CreateReturnBody>;

export const ReceiveReturnBody = z.object({
  warehouseId: PublicId,
  lines: z
    .array(z.object({ lineId: PublicId, receivedQuantity: QuantityString, locationId: PublicId }))
    .min(1)
    .max(200),
});
export type ReceiveReturnBody = z.infer<typeof ReceiveReturnBody>;
export const InspectReturnBody = z.object({
  lines: z
    .array(
      z.object({
        lineId: PublicId,
        condition: z.enum(['sellable', 'damaged', 'scrap']),
        quantity: QuantityString,
      }),
    )
    .min(1)
    .max(200),
});
export type InspectReturnBody = z.infer<typeof InspectReturnBody>;

export const RefundListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  status: z.enum(['pending', 'pending_approval', 'approved', 'paid', 'rejected', 'voided']).optional(),
  returnId: PublicId.optional(),
  orderId: PublicId.optional(),
  customerId: PublicId.optional(),
});
export type RefundListQuery = z.infer<typeof RefundListQuery>;

export const CreateRefundBody = z.object({
  returnId: PublicId.optional(),
  orderId: PublicId.optional(),
  customerId: PublicId,
  amount: MoneyString,
  method: z.enum(['cash', 'bank', 'gateway', 'store_credit']),
  bankAccountId: PublicId.optional(),
  reason: z.string().trim().min(2).max(300),
});
export type CreateRefundBody = z.infer<typeof CreateRefundBody>;

export const PayRefundBody = z.object({
  paymentMethodId: PublicId.optional(),
  reference: z.string().trim().max(200).optional(),
});

export const PaymentBody = z.object({ paidAmount: MoneyString, reference: z.string().max(200).optional() });
