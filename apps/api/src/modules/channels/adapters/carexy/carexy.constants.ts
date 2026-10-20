/** Carexy contract constants (API.md §8.2; contract-confirmed paths). */
export const CAREXY_HOSTS = ['carexy.shop'] as const;
export const CAREXY_BASE_URL = 'https://carexy.shop';
export const CAREXY_API_PREFIX = '/api/v1';

export const CAREXY_PATHS = {
  products: `${CAREXY_API_PREFIX}/products`,
  productShow: (productUuid: string) => `${CAREXY_API_PREFIX}/products/show/${productUuid}`,
  productCreate: `${CAREXY_API_PREFIX}/products/create`,
  productDelete: (productUuid: string) => `${CAREXY_API_PREFIX}/products/delete/${productUuid}`,
  inventoriesOfProduct: (productUuid: string) =>
    `${CAREXY_API_PREFIX}/inventories/product/${productUuid}`,
  inventoryCreate: (productUuid: string) =>
    `${CAREXY_API_PREFIX}/inventories/product/${productUuid}/create`,
  inventoryUpdate: (inventoryUuid: string) =>
    `${CAREXY_API_PREFIX}/inventories/update/${inventoryUuid}`,
  inventoryDelete: (inventoryUuid: string) =>
    `${CAREXY_API_PREFIX}/inventories/delete/${inventoryUuid}`,
  storages: `${CAREXY_API_PREFIX}/storages/`,
  productsInStorage: (storageUuid: string) =>
    `${CAREXY_API_PREFIX}/storages/products/${storageUuid}`,
} as const;

/** No order endpoints exist in the supplied Carexy contract (TBD-CAREXY). */
export const CAREXY_TBD = {
  orders: 'TBD-CAREXY',
  ack: 'TBD-CAREXY',
  shipment: 'TBD-CAREXY',
  webhook: 'TBD-CAREXY',
} as const;

export const CAREXY_CAPABILITIES = [
  'stock.push',
  'price.push',
  'webhook.verify',
  'health.check',
] as const;
