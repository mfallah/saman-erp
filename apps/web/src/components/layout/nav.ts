import type { LucideIcon } from 'lucide-react';
import {
  BadgeDollarSign,
  Boxes,
  Building2,
  ChartNoAxesCombined,
  Handshake,
  LayoutDashboard,
  PlugZap,
  Settings,
  ShoppingCart,
  Tags,
  Truck,
  Users,
  Warehouse,
  Workflow,
} from 'lucide-react';
import { PERM } from '../../lib/permissions';

export interface NavChild {
  readonly label: string;
  readonly to: string;
  readonly permission?: string;
}

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly to?: string;
  readonly permission?: string;
  readonly children?: readonly NavChild[];
}

/**
 * Admin sidebar, exactly the 12 documented groups (ARCHITECTURE / project spec
 * §121): داشبورد، فروش، محصولات، انبار، خرید، قیمت‌گذاری، مالی، شرکا، گزارش‌ها،
 * اتوماسیون، یکپارچه‌سازی‌ها، تنظیمات.
 * Every entry carries the permission key that gates it; the shell filters.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    label: 'داشبورد',
    icon: LayoutDashboard,
    to: '/',
    permission: PERM.dashboardRead,
  },
  {
    key: 'sales',
    label: 'فروش',
    icon: ShoppingCart,
    permission: PERM.orderRead,
    children: [
      { label: 'سفارش‌ها', to: '/orders', permission: PERM.orderRead },
      { label: 'ایستگاه برداشت', to: '/picking', permission: PERM.pickRead },
      { label: 'ایستگاه بسته‌بندی', to: '/packing', permission: PERM.packRead },
    ],
  },
  {
    key: 'products',
    label: 'محصولات',
    icon: Tags,
    permission: PERM.productRead,
    children: [
      { label: 'فهرست کالاها', to: '/products', permission: PERM.productRead },
      { label: 'کالای جدید', to: '/products/new', permission: PERM.productCreate },
    ],
  },
  {
    key: 'inventory',
    label: 'انبار',
    icon: Warehouse,
    permission: PERM.inventoryBalanceRead,
    children: [
      { label: 'موجودی و گردش', to: '/inventory', permission: PERM.inventoryBalanceRead },
      { label: 'انبارها', to: '/warehouses', permission: PERM.warehouseRead },
    ],
  },
  {
    key: 'procurement',
    label: 'خرید',
    icon: Truck,
    to: '/procurement',
    permission: 'purchase.order.read',
  },
  {
    key: 'pricing',
    label: 'قیمت‌گذاری',
    icon: BadgeDollarSign,
    to: '/pricing',
    permission: 'price.list.read',
  },
  {
    key: 'finance',
    label: 'مالی',
    icon: ChartNoAxesCombined,
    permission: PERM.journalRead,
    children: [
      { label: 'دفتر روزنامه', to: '/accounting/journals', permission: PERM.journalRead },
      { label: 'تراز آزمایشی', to: '/accounting/reports/trial-balance', permission: PERM.balanceRead },
      { label: 'سود و زیان', to: '/accounting/reports/profit-loss', permission: PERM.reportRead },
    ],
  },
  {
    key: 'partners',
    label: 'شرکا',
    icon: Handshake,
    to: '/partners',
    permission: 'partner.read',
  },
  {
    key: 'reports',
    label: 'گزارش‌ها',
    icon: Building2,
    to: '/reports',
    permission: PERM.reportRead,
  },
  {
    key: 'automation',
    label: 'اتوماسیون',
    icon: Workflow,
    to: '/automation',
    permission: 'automation.rule.read',
  },
  {
    key: 'integrations',
    label: 'یکپارچه‌سازی‌ها',
    icon: PlugZap,
    to: '/channels',
    permission: PERM.channelRead,
  },
  {
    key: 'settings',
    label: 'تنظیمات',
    icon: Settings,
    permission: PERM.settingRead,
    children: [
      { label: 'کاربران', to: '/users', permission: PERM.userRead },
      { label: 'نقش‌ها', to: '/roles', permission: PERM.roleRead },
      { label: 'تنظیمات سامانه', to: '/settings', permission: PERM.settingRead },
    ],
  },
];

/** Extra icon used in the warehouse area (kept out of the sidebar groups). */
export const LOCATIONS_ICON = Boxes;
export const USERS_ICON = Users;
