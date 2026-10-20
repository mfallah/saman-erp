/**
 * Digikala Open API constants (contract-confirmed catalog: 264 paths/scopes).
 * Request/response **schemas** for marked endpoints are not in the supplied
 * document and stay behind the `TBD-DIGIKALA` feature flag.
 */
export const DIGIKALA_HOSTS = ['seller.digikala.com', 'seller-sandbox.digikala.com'] as const;
export const DIGIKALA_PROD_BASE = 'https://seller.digikala.com/open-api/v1';
export const DIGIKALA_SANDBOX_BASE = 'https://seller-sandbox.digikala.com/open-api/v1';

export const DIGIKALA_PATHS = {
  token: '/auth/token',
  refreshToken: '/auth/refresh-token',
  revoke: '/auth/revoke',
  scopes: '/auth/scopes',
  profile: '/profile',
  profileWarehouse: '/profile/warehouse',
  categories: '/categories/tree',
  sellerProducts: '/products/seller',
  productEdit: (productId: string) => `/product-edit/${productId}`,
  publishProduct: (productId: string) => `/product-edit/${productId}/publish`,
  variantsOfProduct: (productId: string) => `/variants/creation/${productId}`,
  variant: (variantId: string) => `/variants/${variantId}`,
  sellerStock: (variantId: string) => `/variants/${variantId}/seller-stock`,
  bulkSellerStock: '/batch/variant/seller-stock/update',
  sellingPrice: '/variants/selling-price',
  sbsOrders: '/ship-by-seller-orders',
  sbsOrderDetail: (shipmentId: string) => `/ship-by-seller-orders/${shipmentId}`,
  sbsCustomer: (shipmentId: string) => `/ship-by-seller-orders/customer/${shipmentId}`,
  sbsPostData: (shipmentId: string) => `/ship-by-seller-orders/post-data/${shipmentId}`,
  trackingCode: '/ship-by-seller-orders/tracking-code',
  updateStatus: '/ship-by-seller-orders/update-status',
  fullDelivered: '/ship-by-seller-orders/full-delivered',
  label: (registrationMethod: string, parcelNumber: string) =>
    `/shipping-services/label/${registrationMethod}/${parcelNumber}`,
  invoices: '/invoices',
  commissions: '/commissions/',
  webhookEventTypes: '/webhook/event-types',
  webhookSubscription: '/webhook/subscription',
  webhookUnsubscription: '/webhook/unsubscription',
  webhookActivation: '/webhook/subscription/change-activation',
  health: '/',
} as const;

/**
 * Every unconfirmed payload shape is named here. The adapter refuses to call
 * these paths unless `DIGIKALA_TBD_ENABLED=true` (sandbox validation only).
 */
export const TBD_DIGIKALA = {
  productCreatePayload: 'TBD-DIGIKALA:product-creation/save',
  productEditPayload: 'TBD-DIGIKALA:product-edit',
  variantCreatePayload: 'TBD-DIGIKALA:variants/creation',
  bulkStockPayload: 'TBD-DIGIKALA:batch/variant/seller-stock/update',
  pricePushPayload: 'TBD-DIGIKALA:variants/selling-price',
  orderFilters: 'TBD-DIGIKALA:ship-by-seller-orders:filters',
  orderResponse: 'TBD-DIGIKALA:ship-by-seller-orders:response',
  orderStatusEnum: 'TBD-DIGIKALA:ship-by-seller-orders:update-status',
  trackingCodePayload: 'TBD-DIGIKALA:ship-by-seller-orders:tracking-code',
  labelRequest: 'TBD-DIGIKALA:shipping-services/label-request',
  webhookEnvelope: 'TBD-DIGIKALA:webhook:envelope-and-signature',
  webhookSubscriptionPayload: 'TBD-DIGIKALA:webhook/subscription',
  settlementResponse: 'TBD-DIGIKALA:invoices-and-commissions:response',
} as const;

export const DIGIKALA_CAPABILITIES = [
  'stock.push',
  'price.push',
  'order.pull',
  'order.ack',
  'shipment.update',
  'label.print',
  'settlement.pull',
  'webhook.verify',
  'health.check',
] as const;
