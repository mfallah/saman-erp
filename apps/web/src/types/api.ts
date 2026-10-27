/**
 * Client-side view of the API contract (docs/03-api-contract/API.md).
 * Response shapes are normalized to what the SPA reads; server-owned fields are
 * optional so an older/newer API cannot crash a screen (defensive rendering).
 */

export interface Ref {
  readonly id: string;
  readonly name?: string;
  readonly nameFa?: string;
  readonly code?: string;
}

export interface PageMeta {
  readonly mode: 'cursor' | 'offset';
  readonly limit?: number;
  readonly perPage?: number;
  readonly page?: number;
  readonly totalPages?: number;
  readonly nextCursor?: string | null;
  readonly prevCursor?: string | null;
  readonly hasMore?: boolean;
  readonly total?: number;
}

export interface ApiMeta {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly pagination?: PageMeta;
  readonly total?: number;
}

/* ------------------------------------------------------------------ auth */

export interface AuthTokens {
  readonly accessToken: string;
  readonly permissionsVersion?: number;
  readonly expiresIn?: number;
  readonly tokenType?: string;
}

export interface RoleRef {
  readonly id: string;
  readonly name: string;
  readonly nameFa?: string;
}

export interface OrganizationRef {
  readonly id: string;
  readonly name?: string;
  readonly nameFa?: string;
}

export interface UserScope {
  readonly branchIds?: readonly string[];
  readonly warehouseIds?: readonly string[];
}

export interface CurrentUser {
  readonly id: string;
  readonly fullName: string;
  readonly mobile?: string;
  readonly email?: string | null;
  readonly roles?: readonly RoleRef[];
  readonly permissions?: readonly string[];
  readonly scope?: UserScope;
  readonly permissionsVersion?: number;
  readonly mfa?: boolean;
  readonly lastLoginAt?: string | null;
  readonly org?: OrganizationRef;
}

export interface AuthConfig {
  readonly passwordLogin?: boolean;
  readonly otpLogin?: boolean;
  readonly mfaPolicy?: string;
  readonly orgName?: string;
  readonly logoUrl?: string | null;
  readonly smsMode?: 'real' | 'mock';
  readonly policy?: { readonly minLength?: number; readonly zxcvbnMin?: number };
}

export interface LoginResult {
  readonly accessToken?: string;
  readonly permissionsVersion?: number;
  readonly expiresIn?: number;
  readonly user?: CurrentUser;
  readonly mfaRequired?: boolean;
  readonly challengeId?: string;
  readonly methods?: readonly string[];
  readonly expiresInSeconds?: number;
}

export interface OtpChallengeResult {
  readonly challengeId: string;
  readonly expiresIn?: number;
  readonly resendAfter?: number;
  readonly maskMobile?: string;
}

/* ------------------------------------------------------------- catalog */

export type ProductStatus = 'draft' | 'active' | 'inactive' | 'archived' | 'published';

export interface MediaRef {
  readonly id: string;
  readonly url?: string;
  readonly downloadUrl?: string;
  readonly alt?: string;
  readonly isPrimary?: boolean;
  readonly sortOrder?: number;
}

export interface VariantSummary {
  readonly id: string;
  readonly version?: number;
  readonly sku: string;
  readonly barcode?: string | null;
  readonly status?: string;
  readonly unitId?: string;
  readonly unit?: Ref;
  readonly attributes?: readonly { readonly attributeId: string; readonly valueId?: string; readonly rawValue?: string }[];
  readonly media?: readonly MediaRef[];
  readonly createdAt?: string;
}

export interface ProductSummary {
  readonly onHand?: string;
  readonly id: string;
  readonly version: number;
  readonly nameFa: string;
  readonly nameEn?: string | null;
  readonly sku?: string | null;
  readonly status: ProductStatus | string;
  readonly category?: Ref | null;
  readonly brand?: Ref | null;
  readonly unit?: Ref | null;
  readonly hasStock?: boolean;
  readonly variantCount?: number;
  readonly media?: readonly MediaRef[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ProductDetail extends ProductSummary {
  readonly description?: string | null;
  readonly variants?: readonly VariantSummary[];
  readonly attributes?: readonly unknown[];
  readonly suppliers?: readonly unknown[];
}

/** Scanner lookup by barcode/SKU (`GET /catalog/lookup`). */
export interface CatalogLookupResult {
  readonly product?: {
    readonly id: string;
    readonly productNo?: string;
    readonly nameFa: string;
    readonly sku?: string | null;
  };
  readonly variant?: VariantSummary;
  readonly barcode?: { readonly id?: string; readonly value?: string; readonly type?: string };
  readonly location?: unknown;
}

/** What a scanned code resolved to (`GET /scan/lookup?q=`). */
export type ScanLookupKind = 'product' | 'location' | 'order' | 'task';

export interface ScanLookupResult {
  readonly type: ScanLookupKind;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly imageUrl: string | null;
  /** SPA route that opens the resolved record. */
  readonly url: string;
}

export interface CategoryNode extends Ref {
  readonly parentId?: string | null;
  readonly children?: readonly CategoryNode[];
  readonly sortOrder?: number;
}

export interface Brand extends Ref {
  readonly nameFa: string;
  readonly status?: string;
}

export interface Unit extends Ref {
  readonly nameFa: string;
  readonly symbol?: string;
  readonly type?: string;
  readonly isBase?: boolean;
  readonly precision?: number;
}

/* ----------------------------------------------------------- warehouse */

export interface Warehouse extends Ref {
  readonly name: string;
  readonly code: string;
  readonly type?: string;
  readonly status?: string;
  readonly branch?: Ref;
}

export interface LocationNode {
  readonly id: string;
  readonly code: string;
  readonly name?: string;
  readonly type: string;
  readonly status?: string;
  readonly parentId?: string | null;
  readonly barcode?: string | null;
  readonly children?: readonly LocationNode[];
}

/* ------------------------------------------------------------- inventory */

export interface BalanceRow {
  readonly id: string;
  readonly version?: number;
  readonly warehouse?: Ref;
  readonly variant?: Ref;
  readonly product?: Ref;
  readonly location?: Ref;
  readonly onHand: string;
  readonly reserved: string;
  readonly available: string;
  readonly safetyBuffer?: string;
  readonly unitCost?: string | null;
  readonly updatedAt?: string;
}

export interface LedgerRow {
  readonly id: string;
  readonly createdAt?: string;
  readonly type: string;
  readonly warehouse?: Ref;
  readonly variant?: Ref;
  readonly quantity: string;
  readonly unitCost?: string | null;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly balanceAfter?: string | null;
}

export interface AdjustmentLineInput {
  readonly variantId: string;
  readonly locationId?: string;
  readonly quantity: string;
  readonly unitCost?: string;
}

/* ---------------------------------------------------------- channel stock */

/** A channel listing for a variant, with the partner-side identifier. */
export interface StockChannelRef {
  readonly channelCode?: string | null;
  readonly channelName?: string | null;
  readonly externalVariantId?: string | null;
  readonly externalId?: string | null;
}

/** One row of the channel-stock screen: canonical variant + channel listings. */
export interface StockRow {
  readonly id?: string;
  readonly variantId: string;
  readonly productId?: string | null;
  readonly productName: string;
  readonly sku: string;
  readonly onHand: string | number;
  readonly channels?: readonly StockChannelRef[];
}

/** Request body for an inline stock delta (`POST /inventory/stock/adjust`). */
export interface StockAdjustInput {
  readonly variantId: string;
  readonly quantityDelta: number;
  readonly reason: string;
}

/** Result of an inline stock delta; the channels queued for a push. */
export interface StockAdjustResult {
  readonly adjustmentId?: string;
  readonly onHand?: string | number;
  readonly queuedChannels?: readonly (string | StockChannelRef)[];
}

/* ---------------------------------------------------------------- sales */

export interface OrderLine {
  readonly id: string;
  readonly variant?: Ref;
  readonly sku?: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount?: string;
  readonly tax?: string;
  readonly total?: string;
  readonly allocatedQuantity?: string;
  readonly pickedQuantity?: string;
}

export interface SalesOrderSummary {
  readonly id: string;
  readonly version?: number;
  readonly orderNumber?: string;
  readonly status: string;
  readonly channelCode?: string;
  readonly customer?: Ref;
  readonly warehouse?: Ref;
  readonly total?: string;
  readonly currency?: string;
  readonly itemCount?: number;
  readonly orderDate?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SalesOrderDetail extends SalesOrderSummary {
  readonly lines?: readonly OrderLine[];
  readonly allocations?: readonly unknown[];
  readonly shipments?: readonly unknown[];
  readonly history?: readonly { readonly status: string; readonly at: string; readonly actor?: Ref; readonly reason?: string }[];
  readonly shippingAddress?: unknown;
  readonly notes?: string | null;
  readonly subtotal?: string;
  readonly taxTotal?: string;
  readonly shippingTotal?: string;
}

/* ------------------------------------------------------------ fulfillment */

export interface PickTaskLine {
  readonly id: string;
  readonly variant?: Ref;
  readonly sku?: string;
  readonly barcode?: string;
  readonly requestedQuantity: string;
  readonly pickedQuantity?: string;
  readonly location?: Ref;
}

export interface PickTask {
  readonly id: string;
  readonly version?: number;
  readonly status: string;
  readonly orderNumber?: string;
  readonly wave?: Ref;
  readonly assignee?: Ref;
  readonly warehouse?: Ref;
  readonly priority?: number;
  readonly lines?: readonly PickTaskLine[];
  readonly createdAt?: string;
  readonly sequence?: number;
}

/** One open task of the caller (`GET /warehouse/pick-tasks/mine`). */
export interface MyPickTask {
  readonly id: string;
  readonly status: string;
  readonly orderNo?: string | null;
  readonly channelCode?: string | null;
  readonly sku?: string | null;
  readonly title?: string | null;
  readonly productName?: string | null;
  readonly variantSku?: string | null;
  readonly imageUrl?: string | null;
  readonly quantity: string;
  readonly quantityRequired?: string;
  readonly quantityPicked?: string;
  readonly locationCode: string;
  readonly sequenceNo?: number;
  readonly assignedTo?: string | null;
  readonly assignedToName?: string | null;
  readonly createdAt?: string;
  readonly ageMinutes?: number;
}

/** One row of the picking board (`GET /warehouse/pick-tasks/board`). */
export interface PickBoardTask {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly channelCode?: string | null;
  readonly orderStatus: string;
  readonly fulfillmentStatus: string;
  readonly waveId: string | null;
  readonly waveNo: string | null;
  readonly sku: string | null;
  readonly title: string | null;
  readonly productName?: string | null;
  readonly variantSku?: string | null;
  readonly imageUrl?: string | null;
  readonly quantityRequired: string;
  readonly quantityPicked: string;
  readonly locationCode: string | null;
  readonly sequenceNo: number;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly assignedToName: string | null;
  readonly createdAt: string;
  readonly ageMinutes: number;
}

/** Tasks of one order, grouped for the station table. */
export interface PickBoardOrder {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly orderStatus: string;
  readonly fulfillmentStatus: string;
  readonly waveNo: string | null;
  readonly taskCount: number;
  readonly openCount: number;
  readonly assigneeNames: readonly string[];
  readonly oldestAgeMinutes: number;
  readonly tasks: readonly PickBoardTask[];
}

export interface PickBoardSummary {
  readonly openTasks: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly orders: number;
  readonly unassigned: number;
  readonly oldestAgeMinutes: number;
  readonly truncated: boolean;
}

/** Counters that explain why the picking board is empty. */
export interface PickBoardDiagnostics {
  readonly tasksTotal: number;
  readonly openTasks: number;
  readonly ordersTotal: number;
  readonly ordersWithLines: number;
  readonly ordersWithoutLines: number;
  readonly ordersWithoutTasks: number;
  readonly ordersWithoutWarehouse: number;
  readonly warehouses: number;
  readonly activePickers: number;
  readonly fallbackPickers: number;
}

export interface PickTaskBoard {
  readonly generatedAt: string;
  readonly summary: PickBoardSummary;
  readonly diagnostics: PickBoardDiagnostics;
  readonly orders: readonly PickBoardOrder[];
  readonly tasks: readonly PickBoardTask[];
}

/** Result of completing a task on the picking station. */
export interface CompletePickTaskResult {
  readonly task: PickTask;
  readonly orderComplete: boolean;
  readonly packTask: PackTask | null;
  readonly alreadyCompleted?: boolean;
}

/** Result of a barcode-first pick scan (`POST /warehouse/pick-tasks/:id/scan`). */
export interface PickScanResult {
  readonly matched: boolean;
  /** The full barcode that matched (variant barcode, product barcode or SKU). */
  readonly barcode: string;
  readonly task: PickTask;
  readonly orderComplete: boolean;
  readonly packTask: PackTask | null;
  readonly alreadyCompleted?: boolean;
}

/** Who receives the packed goods — drives the packing-station action. */
export type PackHandling = 'digikala_warehouse' | 'ship_to_customer';

/** One order line of a pack task (all lines of the order travel together). */
export interface PackTaskItem {
  readonly name: string;
  readonly sku: string | null;
  readonly qty: string;
  readonly imageUrl: string | null;
}

/** `sales_orders.shipping_address_json` (channel payloads use slightly different keys). */
export interface PackShippingAddress {
  readonly receiverName?: string | null;
  readonly receiverMobile?: string | null;
  readonly province?: string | null;
  readonly city?: string | null;
  readonly district?: string | null;
  readonly line1?: string | null;
  readonly postalCode?: string | null;
  readonly [key: string]: unknown;
}

/** Printable address label returned for a ship-to-customer order. */
export interface PackAddressLabel {
  readonly orderNo: string;
  readonly recipient: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly packageNo: string | null;
}

/** One pack task of the packing station (table `erp.pack_tasks`). */
export interface PackTask {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly channelCode: string | null;
  readonly handling: PackHandling;
  readonly fulfillmentStatus: string;
  readonly packageNo: string | null;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly assignedToName: string | null;
  readonly notes: string | null;
  readonly itemCount: number;
  readonly totalQuantity: string;
  readonly items: readonly PackTaskItem[];
  readonly address: PackShippingAddress | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly ageMinutes: number;
}

/** Result of `POST /warehouse/pack-tasks/:id/complete`. */
export interface CompletePackTaskResult {
  readonly packTask: PackTask;
  readonly orderId: string;
  readonly orderFulfillmentStatus?: string;
  readonly handling: PackHandling;
  /** `null` for Digikala orders (Digikala issues its own shipment barcode). */
  readonly label: PackAddressLabel | null;
  readonly alreadyCompleted: boolean;
}

export interface PackBoardSummary {
  readonly openTasks: number;
  readonly pending: number;
  readonly packing: number;
  readonly packed: number;
  readonly unassigned: number;
  readonly oldestAgeMinutes: number;
  readonly truncated: boolean;
}

export interface PackBoardDiagnostics {
  readonly tasksTotal: number;
  readonly pending: number;
  readonly packing: number;
  readonly packed: number;
  readonly pickedOrders: number;
  readonly pickedOrdersWithoutPackTask: number;
  readonly pickedTasks: number;
}

export interface PackTaskBoard {
  readonly generatedAt: string;
  readonly tableReady: boolean;
  readonly warning?: string;
  readonly summary: PackBoardSummary;
  readonly diagnostics: PackBoardDiagnostics;
  readonly tasks: readonly PackTask[];
}

export interface PackingStation extends Ref {
  readonly name: string;
  readonly warehouse?: Ref;
  readonly active?: boolean;
}

export interface PackingTask {
  readonly id: string;
  readonly version?: number;
  readonly status: string;
  readonly orderNumber?: string;
  readonly station?: Ref;
  readonly expectedItems?: readonly { readonly sku?: string; readonly barcode?: string; readonly quantity: string }[];
  readonly packageId?: string;
  readonly createdAt?: string;
}

/* ------------------------------------------------------------ purchasing */

/** One line of a new purchase receipt (POST /purchasing/receipts). */
export interface PurchaseReceiptLineInput {
  readonly variantId: string;
  readonly quantity: string;
  readonly unitCost?: string;
  /** Serial numbers, one per unit received. */
  readonly serials?: readonly string[];
  /** Optional per-line placement; falls back to the receipt-level warehouse. */
  readonly warehouseId?: string;
  readonly locationId?: string;
}

/** Request body for registering a purchase receipt. */
export interface PurchaseReceiptInput {
  readonly supplierName: string;
  readonly supplierId?: string;
  readonly warehouseId?: string;
  readonly lines: readonly PurchaseReceiptLineInput[];
}

/** One line of an unsaved receipt when previewing its labels. */
export interface PurchaseReceiptLabelLineInput {
  readonly variantId: string;
  readonly quantity: string;
  readonly serials?: readonly string[];
}

/** Request body for `POST /goods-receipts/labels/preview`. */
export interface PurchaseReceiptLabelPreviewInput {
  readonly warehouseId?: string;
  readonly lines: readonly PurchaseReceiptLabelLineInput[];
}

export interface PurchaseReceiptLine {
  readonly id?: string;
  readonly variantId?: string;
  readonly sku?: string;
  readonly productName?: string;
  readonly quantity?: string;
  readonly unitCost?: string;
  readonly serials?: readonly string[];
}

/** A posted purchase receipt row (GET /purchasing/receipts). */
export interface PurchaseReceipt {
  readonly id: string;
  readonly receiptNumber?: string;
  readonly number?: string;
  readonly status?: string;
  readonly supplierId?: string | null;
  readonly supplierName?: string | null;
  readonly supplier?: Ref | null;
  readonly warehouse?: Ref | null;
  readonly warehouseName?: string | null;
  readonly lines?: readonly PurchaseReceiptLine[];
  readonly itemCount?: number;
  readonly total?: string;
  readonly totalCost?: string;
  readonly receivedAt?: string;
  readonly createdAt?: string;
}

/* ------------------------------------------------------------ accounting */

export interface Account extends Ref {
  readonly code: string;
  readonly nameFa: string;
  readonly type: string;
  readonly level?: number;
  readonly isPostable?: boolean;
  readonly parentId?: string | null;
  readonly isActive?: boolean;
}

export interface JournalLineInput {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
  readonly description?: string;
}

export interface JournalLine extends JournalLineInput {
  readonly id?: string;
  readonly account?: Account;
}

export interface JournalEntrySummary {
  readonly id: string;
  readonly version?: number;
  readonly number?: string;
  readonly status: string;
  readonly date?: string;
  readonly description?: string;
  readonly total?: string;
  readonly sourceType?: string;
  readonly createdAt?: string;
}

export interface JournalEntryDetail extends JournalEntrySummary {
  readonly lines?: readonly JournalLine[];
  readonly approval?: unknown;
  readonly sourceLinks?: readonly unknown[];
}

export interface FiscalPeriod {
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface FiscalYear {
  readonly id: string;
  readonly version?: number;
  readonly title: string;
  readonly status?: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly periods?: readonly FiscalPeriod[];
}

export interface AccountBalanceRow {
  readonly id?: string;
  readonly account: Account;
  readonly debit: string;
  readonly credit: string;
  readonly balance: string;
  readonly periodId?: string;
}

/* -------------------------------------------------------------- channels */

export interface Channel extends Ref {
  readonly code: string;
  readonly nameFa: string;
  readonly active?: boolean;
  readonly settings?: Record<string, unknown>;
}

export interface ChannelHealthRow {
  readonly latencyMs?: number | null;
  readonly id?: string;
  readonly channel?: Channel;
  readonly account?: Ref;
  readonly lastSuccessAt?: string | null;
  readonly failureStreak?: number;
  readonly status?: string;
  readonly rateLimitState?: string;
}

export interface ChannelAccount extends Ref {
  readonly nameFa: string;
  readonly channelCode?: string;
  readonly settings?: Record<string, unknown>;
  readonly externalSellerId?: string;
  readonly active?: boolean;
  readonly warehouseIds?: readonly string[];
  readonly credentialMeta?: { readonly last4?: string; readonly rotatedAt?: string; readonly expiresAt?: string };
}

export interface ChannelAccountRsaKeypair {
  readonly publicKeyPem: string;
  readonly publicKeyPkcs1?: string;
  readonly publicKeyBase64?: string;
  readonly fingerprint: string;
  readonly keyBits?: number;
  readonly hasPrivateKey?: boolean;
}

export interface RsaKeyCompareResult {
  readonly match: boolean;
  readonly storedFingerprint: string;
  readonly providedFingerprint: string;
}

export type PricingMode = 'margin' | 'cost_plus_fees';
export type CostSource = 'last_purchase' | 'moving_average' | 'avg_cost' | 'manual';
export type CommissionMode = 'product' | 'fixed' | 'percent';
export type RoundingStep = 'none' | '1000' | '500';

export interface ChannelPricingPolicy {
  readonly mode: PricingMode;
  readonly costSource: CostSource;
  readonly marginPercent: number;
  readonly commissionPercent: number;
  readonly processingFee: number;
  readonly shippingFee: number;
  readonly fixedCommission: number;
  readonly vatPercent: number;
  readonly rounding: RoundingStep;
  /** Policy fields returned by `/pricing/channels` (absent on legacy rows). */
  readonly commissionMode?: CommissionMode;
  readonly autoApply?: boolean;
  readonly autoPush?: boolean;
  readonly updatedAt: string | null;
}

export interface ChannelPricingPolicyRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelCode: string;
  readonly isActive: boolean;
  readonly policy: ChannelPricingPolicy;
}

/** One row per active channel account (`GET /pricing/channels`). */
export interface ChannelPricingAccountView {
  readonly accountId: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly accountName: string;
  readonly policy: ChannelPricingPolicy;
  readonly lastAppliedAt: string | null;
  readonly lastPushStatus: string | null;
  readonly mappedVariants: number;
}

export interface PolicyApplyResult {
  readonly accountId: string;
  readonly applied: number;
  readonly pushed: number;
  readonly missingCommission?: number;
  readonly pushError?: string;
  readonly skipped?: string;
}

export interface PriceBreakdown {
  readonly cost: string;
  readonly marginPercent: number;
  readonly marginAmount: string;
  readonly commissionPercent: number;
  readonly commissionAmount: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly fixedCommission: string;
  readonly vatPercent: number;
  readonly vatAmount: string;
  readonly preVatPrice: string;
  readonly preRoundingPrice: string;
  readonly roundingAdjustment: string;
}

export interface PricePreview {
  readonly accountId: string;
  readonly variantId: string;
  readonly sku: string | null;
  readonly productName: string | null;
  readonly mode: PricingMode;
  readonly cost: string;
  readonly marginAmount: string;
  readonly commissionPercent: number;
  readonly commissionAmount: string;
  readonly processingFee: string;
  readonly shippingFee: string;
  readonly vatAmount: string;
  readonly finalPrice: string;
  readonly breakdown: PriceBreakdown;
}

export interface SyncJob {
  readonly jobType?: string;
  readonly operationKey?: string | null;
  readonly summary?: Record<string, unknown>;
  readonly lastError?: string | null;
  readonly attempts?: number;
  readonly account?: { readonly id?: string; readonly name?: string };
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly progress?: { readonly total?: number; readonly processed?: number; readonly failed?: number };
  readonly createdAt?: string;
  readonly finishedAt?: string | null;
  readonly channel?: Ref;
}

/* ---------------------------------------------------------------- identity */

export interface UserSummary {
  readonly id: string;
  readonly version?: number;
  readonly fullName: string;
  readonly mobile?: string;
  readonly email?: string | null;
  readonly status?: string;
  readonly roles?: readonly RoleRef[];
  readonly lastLoginAt?: string | null;
  readonly createdAt?: string;
}

export interface Role {
  readonly id: string;
  readonly version?: number;
  readonly code?: string;
  readonly name: string;
  readonly nameFa?: string;
  readonly descriptionFa?: string | null;
  readonly isSystem?: boolean;
  readonly permissions?: readonly string[];
}

export interface PermissionGroup {
  readonly resource: string;
  readonly permissions: readonly {
    readonly key: string;
    readonly action: string;
    readonly descriptionFa?: string;
  }[];
}

export interface PermissionRegistry {
  readonly version: number;
  readonly groups: readonly PermissionGroup[];
}

/* ------------------------------------------------------------- reporting */

export interface ReportDefinition {
  readonly code: string;
  readonly titleFa: string;
  readonly category?: string;
  readonly requiredPermission?: string;
  readonly paramsSchema?: unknown;
}

/** One channel account's sync state as returned by the dashboard summary. */
export interface DashboardChannelStatus {
  readonly accountId: string;
  readonly name: string;
  readonly channelCode: string;
  readonly lastSyncAt: string | null;
  readonly lastSyncStatus: string | null;
  readonly stockPushEnabled: boolean;
}

/** Digikala integration state; the token value itself is never returned. */
export interface DashboardDigikalaStatus {
  readonly connected: boolean;
  readonly accessTokenPresent: boolean;
  readonly lastOrderPullAt: string | null;
  readonly lastPushAt: string | null;
  readonly lastError: string | null;
}

export interface DashboardSummary {
  readonly salesToday?: string;
  readonly salesTodayCount?: number;
  readonly profitToday?: string;
  readonly openOrders?: number;
  readonly lowStockCount?: number;
  readonly cashBalance?: string;
  readonly receivable?: string;
  readonly payable?: string;
  readonly syncFailures?: number;
  readonly salesSeries?: readonly { readonly date: string; readonly amount: string }[];
  readonly lowStock?: readonly BalanceRow[];
  readonly recentOrders?: readonly SalesOrderSummary[];
  readonly products?: { readonly total: number; readonly active: number; readonly outOfStock: number };
  readonly inventory?: { readonly onHandTotal: string; readonly skuCount: number };
  readonly orders?: { readonly open: number; readonly today: number };
  readonly sales?: { readonly todayAmount: string; readonly monthAmount: string };
  readonly channels?: readonly DashboardChannelStatus[];
  readonly digikala?: DashboardDigikalaStatus;
}

export interface NotificationItem {
  readonly id: string;
  readonly titleFa?: string;
  readonly bodyFa?: string;
  readonly read?: boolean;
  readonly severity?: string;
  readonly createdAt?: string;
  readonly link?: string;
}

/* ------------------------------------------------------------------ files */

export interface UploadTicket {
  readonly fileId: string;
  readonly uploadUrl: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly expiresIn?: number;
}

export interface UploadedFile {
  readonly id: string;
  readonly fileName: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
}
