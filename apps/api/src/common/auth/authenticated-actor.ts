import type { PermissionKey } from '@saman/shared';

/** Resolved actor attached to the request by the auth guard (identity module). */
export interface AuthenticatedActor {
  /** Internal bigint id (never exposed in JSON). */
  readonly id: bigint;
  /** Public UUID used in API payloads. */
  readonly publicId: string;
  readonly orgId: bigint;
  readonly orgPublicId: string;
  readonly permissions: readonly PermissionKey[];
  /** null = unrestricted for the actor's role (superadmin); [] = none. */
  readonly branchIds: bigint[] | null;
  readonly warehouseIds: bigint[] | null;
  readonly sessionId: bigint;
  readonly sessionPublicId: string;
  readonly permissionsVersion: number;
  readonly userAgentHash?: string;
  readonly stepUpAt?: Date;
}
