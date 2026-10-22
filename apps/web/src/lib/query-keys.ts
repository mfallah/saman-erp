import type { QueryParams } from './api-client';

/**
 * Central query-key factory. Keys include params so TanStack Query caches are
 * scoped correctly and invalidations stay predictable.
 */
export const queryKeys = {
  auth: {
    config: ['auth', 'config'] as const,
    me: ['auth', 'me'] as const,
    sessions: ['auth', 'sessions'] as const,
    devices: ['auth', 'devices'] as const,
  },
  dashboard: {
    summary: (params?: QueryParams) => ['dashboard', 'summary', params ?? {}] as const,
  },
  catalog: {
    products: (params?: QueryParams) => ['products', params ?? {}] as const,
    product: (id: string) => ['products', id] as const,
    variants: (productId: string) => ['products', productId, 'variants'] as const,
    categories: ['categories'] as const,
    brands: ['brands'] as const,
    units: ['units'] as const,
  },
  inventory: {
    balances: (params?: QueryParams) => ['inventory', 'balances', params ?? {}] as const,
    ledger: (params?: QueryParams) => ['inventory', 'ledger', params ?? {}] as const,
    adjustments: (params?: QueryParams) => ['inventory', 'adjustments', params ?? {}] as const,
  },
  warehouses: {
    list: ['warehouses'] as const,
    tree: (id: string) => ['warehouses', id, 'tree'] as const,
    details: (id: string) => ['warehouses', id] as const,
  },
  orders: {
    list: (params?: QueryParams) => ['orders', params ?? {}] as const,
    detail: (id: string) => ['orders', id] as const,
  },
  fulfillment: {
    pickTasks: (params?: QueryParams) => ['pick-tasks', params ?? {}] as const,
    pickTask: (id: string) => ['pick-tasks', id] as const,
    packingTasks: (params?: QueryParams) => ['packing-tasks', params ?? {}] as const,
    packingTask: (id: string) => ['packing-tasks', id] as const,
    packingStations: ['packing-stations'] as const,
  },
  accounting: {
    accounts: (params?: QueryParams) => ['accounting', 'accounts', params ?? {}] as const,
    journals: (params?: QueryParams) => ['accounting', 'journals', params ?? {}] as const,
    journal: (id: string) => ['accounting', 'journals', id] as const,
    fiscalYears: ['accounting', 'fiscal-years'] as const,
    accountBalances: (params?: QueryParams) => ['accounting', 'account-balances', params ?? {}] as const,
  },
  channels: {
    list: ['channels'] as const,
    health: ['channels', 'health'] as const,
    accounts: (channelId: string) => ['channels', channelId, 'accounts'] as const,
    syncJobs: (params?: QueryParams) => ['channel-sync-jobs', params ?? {}] as const,
    mappings: (channelId: string, params?: QueryParams) =>
      ['channels', channelId, 'product-mappings', params ?? {}] as const,
    pricingPolicies: (channelId: string) => ['channels', channelId, 'pricing-policy'] as const,
    allPricingPolicies: ['pricing', 'policies'] as const,
    pricePreview: (accountId: string, variantId: string) =>
      ['pricing', 'preview', accountId, variantId] as const,
  },
  identity: {
    users: (params?: QueryParams) => ['users', params ?? {}] as const,
    roles: (params?: QueryParams) => ['roles', params ?? {}] as const,
    role: (id: string) => ['roles', id] as const,
    permissions: ['permissions'] as const,
  },
  settings: {
    group: (group: string) => ['settings', group] as const,
    organization: ['organization'] as const,
  },
  reports: {
    catalog: (params?: QueryParams) => ['reports', params ?? {}] as const,
    runs: (params?: QueryParams) => ['reports', 'runs', params ?? {}] as const,
  },
  notifications: {
    inbox: ['notifications'] as const,
  },
} as const;
