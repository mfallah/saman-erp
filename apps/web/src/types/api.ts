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
  readonly externalSellerId?: string;
  readonly active?: boolean;
  readonly warehouseIds?: readonly string[];
  readonly credentialMeta?: { readonly last4?: string; readonly rotatedAt?: string; readonly expiresAt?: string };
}

export interface SyncJob {
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
