import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type ErrorComponentProps,
  type RouterHistory,
} from '@tanstack/react-router';
import { logger } from './lib/logger';
import { guardAnyPermission, guardAuthenticated, guardGuest, guardPermission } from './lib/guards';
import { PERM } from './lib/permissions';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPage } from './pages/ComingSoonPage';
import { ForbiddenPage, NotFoundPage, ServerErrorPage } from './pages/ErrorPages';

/* --------------------------------------------------------------- layouts */

function RootLayout() {
  return <Outlet />;
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  logger.error('unhandled route error', { error: error instanceof Error ? error.message : String(error) });
  return <ServerErrorPage onRetry={reset} />;
}

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/* ----------------------------------------------------------------- pages */

const LoginPage = lazyRouteComponent(() => import('./pages/LoginPage'), 'LoginPage');
const DashboardPage = lazyRouteComponent(() => import('./pages/DashboardPage'), 'DashboardPage');
const ProductsListPage = lazyRouteComponent(() => import('./pages/ProductsListPage'), 'ProductsListPage');
const ProductNewPage = lazyRouteComponent(() => import('./pages/ProductNewPage'), 'ProductNewPage');
const ProductDetailPage = lazyRouteComponent(() => import('./pages/ProductDetailPage'), 'ProductDetailPage');
const InventoryPage = lazyRouteComponent(() => import('./pages/InventoryPage'), 'InventoryPage');
const InventoryStockPage = lazyRouteComponent(
  () => import('./pages/InventoryStockPage'),
  'InventoryStockPage',
);
const WarehousesPage = lazyRouteComponent(() => import('./pages/WarehousesPage'), 'WarehousesPage');
const WarehouseLocationsPage = lazyRouteComponent(
  () => import('./pages/WarehouseLocationsPage'),
  'WarehouseLocationsPage',
);
const OrdersListPage = lazyRouteComponent(() => import('./pages/OrdersListPage'), 'OrdersListPage');
const OrderDetailPage = lazyRouteComponent(() => import('./pages/OrderDetailPage'), 'OrderDetailPage');
const PickingPage = lazyRouteComponent(() => import('./pages/PickingPage'), 'PickingPage');
const PackingPage = lazyRouteComponent(() => import('./pages/PackingPage'), 'PackingPage');
const JournalsListPage = lazyRouteComponent(() => import('./pages/JournalsListPage'), 'JournalsListPage');
const JournalCreatePage = lazyRouteComponent(() => import('./pages/JournalCreatePage'), 'JournalCreatePage');
const TrialBalancePage = lazyRouteComponent(() => import('./pages/TrialBalancePage'), 'TrialBalancePage');
const ProfitLossPage = lazyRouteComponent(() => import('./pages/ProfitLossPage'), 'ProfitLossPage');
const ChannelsPage = lazyRouteComponent(() => import('./pages/ChannelsPage'), 'ChannelsPage');
const PricingRulesPage = lazyRouteComponent(() => import('./pages/PricingRulesPage'), 'PricingRulesPage');
const ChannelPricingPage = lazyRouteComponent(
  () => import('./pages/ChannelPricingPage'),
  'ChannelPricingPage',
);
const UsersPage = lazyRouteComponent(() => import('./pages/UsersPage'), 'UsersPage');
const RolesPage = lazyRouteComponent(() => import('./pages/RolesPage'), 'RolesPage');
const SettingsPage = lazyRouteComponent(() => import('./pages/SettingsPage'), 'SettingsPage');
const ReportsPage = lazyRouteComponent(() => import('./pages/ReportsPage'), 'ReportsPage');
const PurchasingPage = lazyRouteComponent(() => import('./pages/PurchasingPage'), 'PurchasingPage');
const ScanPage = lazyRouteComponent(() => import('./pages/ScanPage'), 'ScanPage');

/* ------------------------------------------------------- coming-soon pages */

const ProcurementPage = () => (
  <ComingSoonPage
    title="خرید"
    description="مدیریت تأمین‌کنندگان، سفارش خرید، رسید کالا و فاکتور تأمین‌کننده در این بخش قرار می‌گیرد."
  />
);
const PricingPage = PricingRulesPage;

const PartnersPage = () => (
  <ComingSoonPage
    title="شرکا"
    description="سهام‌داران، حساب شرکا، تقسیم سود و تسویه کانال‌ها در این بخش قرار می‌گیرد."
  />
);
const AutomationPage = () => (
  <ComingSoonPage
    title="اتوماسیون"
    description="قواعد کسب‌وکار، هشدارها و پرچم‌های ریسک در این بخش مدیریت می‌شوند."
  />
);

/* ---------------------------------------------------------------- routes */

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorComponent,
});

interface LoginSearch {
  redirect?: string;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search['redirect'] === 'string' ? search['redirect'] : undefined,
  }),
  beforeLoad: async () => {
    await guardGuest();
  },
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: async ({ location }) => {
    await guardAuthenticated(location.href);
  },
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => guardPermission(PERM.dashboardRead),
  component: DashboardPage,
});

const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products',
  beforeLoad: () => guardPermission(PERM.productRead),
  component: ProductsListPage,
});

const productNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/new',
  beforeLoad: () => guardPermission(PERM.productCreate),
  component: ProductNewPage,
});

const productDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products/$id',
  beforeLoad: () => guardPermission(PERM.productRead),
  component: ProductDetailPage,
});

const inventoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/inventory',
  beforeLoad: () => guardPermission(PERM.inventoryBalanceRead),
  component: InventoryPage,
});

const inventoryStockRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/inventory/stock',
  beforeLoad: () => guardPermission(PERM.inventoryRead),
  component: InventoryStockPage,
});

const warehousesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/warehouses',
  beforeLoad: () => guardPermission(PERM.warehouseRead),
  component: WarehousesPage,
});

const warehouseLocationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/warehouses/$id/locations',
  beforeLoad: () => guardPermission(PERM.locationRead),
  component: WarehouseLocationsPage,
});

const ordersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/orders',
  beforeLoad: () => guardPermission(PERM.orderRead),
  component: OrdersListPage,
});

const orderDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/orders/$id',
  beforeLoad: () => guardPermission(PERM.orderRead),
  component: OrderDetailPage,
});

const pickingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/picking',
  beforeLoad: () => guardPermission(PERM.pickRead),
  component: PickingPage,
});

const packingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/packing',
  beforeLoad: () => guardPermission(PERM.packRead),
  component: PackingPage,
});

const journalsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounting/journals',
  beforeLoad: () => guardPermission(PERM.journalRead),
  component: JournalsListPage,
});

const journalNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounting/journals/new',
  beforeLoad: () => guardPermission(PERM.journalCreate),
  component: JournalCreatePage,
});

const trialBalanceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounting/reports/trial-balance',
  beforeLoad: () => guardPermission(PERM.balanceRead),
  component: TrialBalancePage,
});

const profitLossRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/accounting/reports/profit-loss',
  beforeLoad: () => guardPermission(PERM.reportRead),
  component: ProfitLossPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/channels',
  beforeLoad: () => guardPermission(PERM.channelRead),
  component: ChannelsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/users',
  beforeLoad: () => guardPermission(PERM.userRead),
  component: UsersPage,
});

const rolesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/roles',
  beforeLoad: () => guardPermission(PERM.roleRead),
  component: RolesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  beforeLoad: () => guardPermission(PERM.settingRead),
  component: SettingsPage,
});

const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/reports',
  beforeLoad: () => guardPermission(PERM.reportRead),
  component: ReportsPage,
});

const purchasingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/purchasing',
  // Purchase or inventory visibility both open the receipt workspace.
  beforeLoad: () => guardAnyPermission([PERM.purchaseRead, PERM.inventoryBalanceRead]),
  component: PurchasingPage,
});

/** Scanner entry point: available to every authenticated user. */
const scanRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/scan',
  component: ScanPage,
});

const procurementRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/procurement',
  component: ProcurementPage,
});

const pricingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pricing',
  component: PricingPage,
});

const channelPricingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pricing/channels',
  beforeLoad: () => guardPermission(PERM.accountRead),
  component: ChannelPricingPage,
});

const partnersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/partners',
  component: PartnersPage,
});

const automationRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/automation',
  component: AutomationPage,
});

const forbiddenRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/forbidden',
  component: ForbiddenPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    dashboardRoute,
    productsRoute,
    productNewRoute,
    productDetailRoute,
    inventoryRoute,
    inventoryStockRoute,
    warehousesRoute,
    warehouseLocationsRoute,
    ordersRoute,
    orderDetailRoute,
    pickingRoute,
    packingRoute,
    journalsRoute,
    journalNewRoute,
    trialBalanceRoute,
    profitLossRoute,
    channelsRoute,
    usersRoute,
    rolesRoute,
    settingsRoute,
    reportsRoute,
    purchasingRoute,
    scanRoute,
    procurementRoute,
    pricingRoute,
    channelPricingRoute,
    partnersRoute,
    automationRoute,
    forbiddenRoute,
  ]),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history === undefined ? {} : { history }),
    defaultPreload: 'intent',
    defaultPendingMs: 250,
    defaultPendingMinMs: 150,
    scrollRestoration: true,
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
