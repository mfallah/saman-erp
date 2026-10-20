/**
 * Category tree engine — adjacency list with a materialized `path`/`level`
 * (`DATA-MODEL` §2.4 `catalog.product_categories`).
 *
 * The tree is adjacency-based (no ltree dependency). Each node stores
 * `path = '/<rootId>/<...>/<id>/'` and `level`, so subtree reads are a single
 * `path LIKE '/1/14/%'` and move operations are one bulk prefix rewrite kept in
 * the same transaction. This module is pure: the service composes it with the
 * repository and tests it without a database.
 */
import { AppError } from '@saman/shared';

export const MAX_CATEGORY_LEVEL = 8;

const PATH_PATTERN = /^\/(?:\d+\/)+$/;

export function isValidCategoryPath(path: string): boolean {
  return PATH_PATTERN.test(path);
}

/** Builds the materialized path for a node from its parent's path. */
export function buildCategoryPath(parentPath: string | null | undefined, categoryId: bigint | number): string {
  const id = categoryId.toString();
  if (!/^\d+$/.test(id)) {
    throw new RangeError('category_id_must_be_numeric');
  }
  if (parentPath === null || parentPath === undefined || parentPath === '') {
    return `/${id}/`;
  }
  if (!isValidCategoryPath(parentPath)) {
    throw new RangeError(`invalid_category_path:${parentPath}`);
  }
  return `${parentPath}${id}/`;
}

/** Level = number of ids in the path (`/1/` → 1). */
export function levelFromPath(path: string): number {
  if (!isValidCategoryPath(path)) {
    throw new RangeError(`invalid_category_path:${path}`);
  }
  return path.split('/').filter((segment) => segment.length > 0).length;
}

/** True when `candidatePath` is inside (or equal to) `ancestorPath`. */
export function isDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(ancestorPath);
}

/** `LIKE` pattern that selects the whole subtree including the node itself. */
export function subtreePattern(path: string): string {
  if (!isValidCategoryPath(path)) {
    throw new RangeError(`invalid_category_path:${path}`);
  }
  return `${path.replace(/\/$/, '')}%`;
}

/**
 * Guards a re-parent operation against cycles and depth overflow.
 * Re-parenting a node under itself or one of its own descendants is rejected
 * with `RULE_VIOLATION` rule `category_cycle`.
 */
export function assertValidReparent(input: {
  categoryId: bigint | number;
  categoryPath: string;
  newParentId: bigint | number | null;
  newParentPath: string | null;
}): void {
  const ownPath = input.categoryPath;
  if (input.newParentId === null || input.newParentPath === null) {
    // Moving to root: path becomes the bare id, always safe.
    return;
  }
  if (input.newParentId.toString() === input.categoryId.toString()) {
    throw cycleError();
  }
  if (isDescendantPath(input.newParentPath, ownPath)) {
    throw cycleError();
  }
  const newLevel = levelFromPath(buildCategoryPath(input.newParentPath, input.categoryId));
  if (newLevel > MAX_CATEGORY_LEVEL) {
    throw new AppError('RULE_VIOLATION', {
      message: 'عمق مجاز درخت دسته‌بندی بیش از حد مجاز است.',
      messageKey: 'catalog.category_depth_exceeded',
      details: [{ rule: 'category_depth_exceeded', params: { maxLevel: MAX_CATEGORY_LEVEL } }],
    });
  }
}

/**
 * Rewrites the path of a moved subtree: replaces the old node prefix with the
 * new node prefix. Pure so the exact rewrite is unit tested before touching the
 * database.
 */
export function reparentPath(currentPath: string, oldNodePath: string, newNodePath: string): string {
  if (!isDescendantPath(currentPath, oldNodePath)) {
    throw new RangeError('path_outside_subtree');
  }
  return `${newNodePath}${currentPath.slice(oldNodePath.length)}`;
}

/** Level delta applied to the whole subtree when a node moves. */
export function reparentLevelDelta(oldNodePath: string, newNodePath: string): number {
  return levelFromPath(newNodePath) - levelFromPath(oldNodePath);
}

/** Flattens the adjacency list into a nested tree for `?tree=true` responses. */
export interface CategoryRow {
  readonly id: bigint;
  readonly parentId: bigint | null;
  readonly code: string;
  readonly name: string;
  readonly level: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface CategoryNode<T extends CategoryRow = CategoryRow> extends CategoryRow {
  readonly children: CategoryNode<T>[];
}

export function buildCategoryTree<T extends CategoryRow>(rows: readonly T[]): CategoryNode<T>[] {
  const nodes = new Map<string, CategoryNode<T>>();
  for (const row of rows) {
    nodes.set(row.id.toString(), { ...row, children: [] });
  }
  const roots: CategoryNode<T>[] = [];
  for (const node of nodes.values()) {
    const parentKey = node.parentId === null ? null : node.parentId.toString();
    const parent = parentKey === null ? undefined : nodes.get(parentKey);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  const sort = (list: CategoryNode<T>[]): void => {
    list.sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.code.localeCompare(right.code);
    });
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** Ancestor ids parsed from the materialized path, root first. */
export function ancestorIds(path: string, selfId?: bigint | number): bigint[] {
  const ids = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => BigInt(segment));
  if (selfId !== undefined) {
    const self = selfId.toString();
    return ids.filter((id) => id.toString() !== self);
  }
  return ids;
}

function cycleError(): AppError {
  return new AppError('RULE_VIOLATION', {
    message: 'انتقال این دسته‌بندی باعث ایجاد حلقه در درخت می‌شود.',
    messageKey: 'catalog.category_cycle',
    details: [{ rule: 'category_cycle' }],
  });
}
