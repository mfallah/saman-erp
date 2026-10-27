import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, MapPin, Pencil, Plus, Trash2, Warehouse as WarehouseIcon } from 'lucide-react';
import { api, newRequestId, toFaErrorMessage } from '../lib/api-client';
import { useDebouncedValue, useDocumentTitle } from '../lib/hooks';
import { formatQuantity } from '../lib/money';
import { PERM } from '../lib/permissions';
import { queryKeys } from '../lib/query-keys';
import { useHasPermission } from '../lib/use-auth';
import type { Warehouse } from '../types/api';
import { PermissionNotice } from '../components/auth/Can';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Checkbox } from '../components/ui/Checkbox';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTableToolbar } from '../components/ui/DataTableToolbar';
import { EmptyState } from '../components/ui/EmptyState';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Pagination } from '../components/ui/Pagination';
import { Select, type SelectOption } from '../components/ui/Select';
import { DataTable, type Column } from '../components/ui/Table';
import { Textarea } from '../components/ui/Textarea';
import { useToast } from '../components/ui/Toast';

/* --------------------------------------------------------------- contracts */

interface WarehouseRecord extends Warehouse {
  readonly city?: string | null;
  readonly address?: string | null;
  readonly branchId?: string | null;
  readonly version?: number;
}

interface WarehouseLocation {
  readonly id: string;
  readonly warehouseId?: string;
  readonly code: string;
  readonly fullCode?: string;
  readonly barcode?: string | null;
  readonly type: string;
  readonly pickPriority?: number;
  readonly isPickable?: boolean;
  readonly status?: string;
  readonly capacity?: string | null;
  readonly version?: number;
}

interface LocationTreeNode {
  readonly id: string;
  readonly code: string;
  readonly name?: string;
  readonly level?: string;
  readonly fullCode?: string | null;
  readonly parentId?: string | null;
  readonly abcClass?: string | null;
  readonly capacityQuantity?: string | null;
  readonly pickPriority?: number | null;
  readonly children?: readonly LocationTreeNode[];
}

interface FlatLocationNode {
  readonly id: string;
  readonly code: string;
  readonly name?: string;
  readonly fullCode: string | null;
  readonly level: LocationNodeLevel;
  readonly parentId: string | null;
  readonly parentCode: string | null;
  readonly depth: number;
  readonly label: string;
  readonly capacityQuantity: string | null;
  readonly pickPriority: number | null;
  readonly abcClass: string | null;
}

interface CreateWarehousePayload {
  readonly code: string;
  readonly name: string;
  readonly type: WarehouseTypeValue;
  readonly city?: string;
  readonly address?: string;
}

interface UpdateWarehousePayload {
  readonly name: string;
  readonly city?: string;
  readonly address?: string;
  readonly status: WarehouseStatusValue;
}

interface CreateLocationPayload {
  readonly code: string;
  readonly type: LocationNodeLevel;
  readonly parentId?: string;
  readonly name?: string;
  readonly capacity?: string;
  readonly barcode?: string;
  readonly pickPriority?: number;
  readonly isPickFace?: boolean;
  readonly locationType?: LocationUsage;
}

interface UpdateLocationPayload {
  readonly barcode: string;
  readonly pickPriority: number;
  readonly isPickable: boolean;
  readonly status: WarehouseStatusValue;
}

/* ----------------------------------------------------------------- labels */

const LOCATION_LEVELS = ['zone', 'aisle', 'rack', 'shelf', 'bin', 'location'] as const;
type LocationNodeLevel = (typeof LOCATION_LEVELS)[number];

const LOCATION_USAGES = ['bin', 'staging', 'receiving', 'shipping', 'quarantine', 'scrap', 'transit'] as const;
type LocationUsage = (typeof LOCATION_USAGES)[number];
type WarehouseTypeValue = 'main' | 'transit' | 'return';
type WarehouseStatusValue = 'active' | 'inactive';

const WAREHOUSE_TYPE_LABELS: Readonly<Record<string, string>> = {
  main: 'انبار اصلی',
  transit: 'انبار ترانزیتی',
  return: 'انبار مرجوعی',
  returns: 'انبار مرجوعی',
};

const LOCATION_LEVEL_LABELS: Readonly<Record<LocationNodeLevel, string>> = {
  zone: 'ناحیه',
  aisle: 'راهرو',
  rack: 'رَک',
  shelf: 'طبقه',
  bin: 'بین',
  location: 'موقعیت (برگ)',
};

const LOCATION_USAGE_LABELS: Readonly<Record<LocationUsage, string>> = {
  bin: 'بین استاندارد',
  staging: 'محوطه آماده‌سازی',
  receiving: 'دریافت',
  shipping: 'ارسال',
  quarantine: 'قرنطینه',
  scrap: 'ضایعات',
  transit: 'ترانزیت',
};

const PARENT_LEVEL: Readonly<Record<LocationNodeLevel, LocationNodeLevel | null>> = {
  zone: null,
  aisle: 'zone',
  rack: 'aisle',
  shelf: 'rack',
  bin: 'shelf',
  location: 'bin',
};

function childLevelOf(level: LocationNodeLevel): LocationNodeLevel | null {
  const index = LOCATION_LEVELS.indexOf(level);
  return index >= 0 && index < LOCATION_LEVELS.length - 1
    ? (LOCATION_LEVELS[index + 1] ?? null)
    : null;
}

function locationLevelTone(
  level: LocationNodeLevel,
): 'brand' | 'info' | 'success' | 'warning' | 'neutral' {
  switch (level) {
    case 'zone':
      return 'brand';
    case 'aisle':
      return 'info';
    case 'rack':
      return 'success';
    case 'shelf':
      return 'warning';
    default:
      return 'neutral';
  }
}

const WAREHOUSE_TYPE_OPTIONS: readonly SelectOption[] = [
  { value: 'main', label: 'انبار اصلی' },
  { value: 'transit', label: 'انبار ترانزیتی' },
  { value: 'return', label: 'انبار مرجوعی' },
];

const WAREHOUSE_STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'همه وضعیت‌ها' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
];

const WAREHOUSE_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
];

const LOCATION_LEVEL_OPTIONS: readonly SelectOption[] = LOCATION_LEVELS.map((level) => ({
  value: level,
  label: LOCATION_LEVEL_LABELS[level],
}));

const LOCATION_USAGE_OPTIONS: readonly SelectOption[] = LOCATION_USAGES.map((usage) => ({
  value: usage,
  label: LOCATION_USAGE_LABELS[usage],
}));

function isLocationNodeLevel(value: string | undefined): value is LocationNodeLevel {
  return value !== undefined && (LOCATION_LEVELS as readonly string[]).includes(value);
}

function isWarehouseStatus(value: string): value is WarehouseStatusValue {
  return value === 'active' || value === 'inactive';
}

function warehouseTypeLabel(type: string | undefined): string {
  if (type === undefined || type === '') {
    return '—';
  }
  return WAREHOUSE_TYPE_LABELS[type] ?? type;
}

function locationUsageLabel(type: string): string {
  return LOCATION_USAGE_LABELS[type as LocationUsage] ?? type;
}

function normalizeWarehouseType(type: string | undefined): WarehouseTypeValue {
  if (type === 'transit') {
    return 'transit';
  }
  if (type === 'return' || type === 'returns') {
    return 'return';
  }
  return 'main';
}

interface CollectedLocationNode {
  readonly node: LocationTreeNode;
  readonly parentId: string | null;
}

function collectLocationNodes(
  nodes: readonly LocationTreeNode[],
  inheritedParentId: string | null,
  result: CollectedLocationNode[],
  seen: Set<string>,
): void {
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    result.push({ node, parentId: node.parentId ?? inheritedParentId });
    if (node.children !== undefined && node.children.length > 0) {
      collectLocationNodes(node.children, node.id, result, seen);
    }
  }
}

/**
 * Normalizes both response shapes: the current API sends a flat list with
 * `parentId` (union of zones → locations), while older responses nested the
 * nodes in `children`. The resulting rows are ordered depth-first so a table
 * can render them as an indented tree.
 */
function flattenLocationTree(nodes: readonly LocationTreeNode[]): FlatLocationNode[] {
  const collected: CollectedLocationNode[] = [];
  collectLocationNodes(nodes, null, collected, new Set<string>());

  const byId = new Map(collected.map((entry) => [entry.node.id, entry]));
  const childrenByParent = new Map<string | null, CollectedLocationNode[]>();
  for (const entry of collected) {
    const resolvedParentId =
      entry.parentId !== null && byId.has(entry.parentId) ? entry.parentId : null;
    const siblings = childrenByParent.get(resolvedParentId);
    if (siblings === undefined) {
      childrenByParent.set(resolvedParentId, [entry]);
    } else {
      siblings.push(entry);
    }
  }

  const result: FlatLocationNode[] = [];
  const visited = new Set<string>();

  const visit = (
    entry: CollectedLocationNode,
    depth: number,
    ancestors: readonly string[],
  ): void => {
    if (visited.has(entry.node.id)) {
      return;
    }
    visited.add(entry.node.id);
    const { node } = entry;
    const level = isLocationNodeLevel(node.level)
      ? node.level
      : (LOCATION_LEVELS[depth] ?? 'location');
    const path = [...ancestors, node.code];
    const resolvedParentId =
      entry.parentId !== null && byId.has(entry.parentId) ? entry.parentId : null;
    result.push({
      id: node.id,
      code: node.code,
      name: node.name,
      fullCode: node.fullCode ?? null,
      level,
      parentId: resolvedParentId,
      parentCode:
        resolvedParentId === null ? null : (byId.get(resolvedParentId)?.node.code ?? null),
      depth,
      label: node.fullCode ?? path.join(' / '),
      capacityQuantity: node.capacityQuantity ?? null,
      pickPriority: typeof node.pickPriority === 'number' ? node.pickPriority : null,
      abcClass: node.abcClass ?? null,
    });
    for (const child of childrenByParent.get(node.id) ?? []) {
      visit(child, depth + 1, path);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    visit(root, 0, []);
  }
  // Defensive fallback for cycles or orphaned parent references.
  for (const entry of collected) {
    if (!visited.has(entry.node.id)) {
      visit(entry, 0, []);
    }
  }
  return result;
}

/* ------------------------------------------------------------------- page */

/**
 * Warehouse & location management: warehouse CRUD on top, the selected
 * warehouse's stock locations underneath. Backend contracts follow
 * `apps/api/src/modules/warehouse/dto/warehouse.dto.ts` (the API uses
 * `type`/`status` rather than nameFa/warehouseType/isActive).
 */
export function WarehousesPage() {
  useDocumentTitle('انبارها و موقعیت‌ها');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canRead = useHasPermission(PERM.warehouseRead);
  const canCreate = useHasPermission(PERM.warehouseCreate);
  const canUpdate = useHasPermission(PERM.warehouseUpdate);
  const canDelete = useHasPermission(PERM.warehouseDelete);
  const canReadLocations = useHasPermission(PERM.locationRead);
  const canCreateLocations = useHasPermission(PERM.locationCreate);
  const canUpdateLocations = useHasPermission(PERM.locationUpdate);
  const canDeleteLocations = useHasPermission(PERM.locationDelete);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);

  const [selectedWarehouse, setSelectedWarehouse] = useState<WarehouseRecord | null>(null);

  const [warehouseModalOpen, setWarehouseModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseRecord | null>(null);
  const [warehouseAttempted, setWarehouseAttempted] = useState(false);
  const [warehouseCode, setWarehouseCode] = useState('');
  const [warehouseName, setWarehouseName] = useState('');
  const [warehouseType, setWarehouseType] = useState<WarehouseTypeValue>('main');
  const [warehouseCity, setWarehouseCity] = useState('');
  const [warehouseAddress, setWarehouseAddress] = useState('');
  const [warehouseStatus, setWarehouseStatus] = useState<WarehouseStatusValue>('active');
  const [warehouseDeleteTarget, setWarehouseDeleteTarget] = useState<WarehouseRecord | null>(null);

  const [locationCreateOpen, setLocationCreateOpen] = useState(false);
  const [locationAttempted, setLocationAttempted] = useState(false);
  const [locationCode, setLocationCode] = useState('');
  const [locationName, setLocationName] = useState('');
  const [locationLevel, setLocationLevel] = useState<LocationNodeLevel>('location');
  const [locationParentId, setLocationParentId] = useState('');
  const [locationUsage, setLocationUsage] = useState<LocationUsage>('bin');
  const [locationCapacity, setLocationCapacity] = useState('');
  const [locationBarcode, setLocationBarcode] = useState('');
  const [locationPriority, setLocationPriority] = useState('0');
  const [locationIsPickFace, setLocationIsPickFace] = useState(true);

  const [locationEditTarget, setLocationEditTarget] = useState<WarehouseLocation | null>(null);
  const [editLocationAttempted, setEditLocationAttempted] = useState(false);
  const [editLocationBarcode, setEditLocationBarcode] = useState('');
  const [editLocationPriority, setEditLocationPriority] = useState('0');
  const [editLocationPickable, setEditLocationPickable] = useState(true);
  const [editLocationStatus, setEditLocationStatus] = useState<WarehouseStatusValue>('active');
  const [locationDeleteTarget, setLocationDeleteTarget] = useState<WarehouseLocation | null>(null);

  const warehousesQuery = useQuery({
    queryKey: [...queryKeys.warehouses.list, { page, q: debouncedSearch, status: statusFilter }],
    queryFn: () =>
      api.getPage<WarehouseRecord>('/warehouses', {
        page,
        perPage: 50,
        ...(debouncedSearch.trim().length >= 2 ? { q: debouncedSearch.trim() } : {}),
        ...(statusFilter === '' ? {} : { status: statusFilter }),
      }),
    enabled: canRead,
  });

  const selectedWarehouseId = selectedWarehouse?.id ?? null;

  const treeQuery = useQuery({
    queryKey: queryKeys.warehouses.tree(selectedWarehouseId ?? ''),
    queryFn: () => api.get<readonly LocationTreeNode[]>(`/warehouses/${selectedWarehouseId ?? ''}/tree`),
    enabled: canReadLocations && selectedWarehouseId !== null,
    staleTime: 60_000,
  });

  const locationsQuery = useQuery({
    queryKey: queryKeys.warehouses.locations(selectedWarehouseId ?? ''),
    queryFn: () =>
      api.getPage<WarehouseLocation>(`/warehouses/${selectedWarehouseId ?? ''}/locations`, {
        limit: 500,
      }),
    enabled: canReadLocations && selectedWarehouseId !== null,
  });

  const flatTree = useMemo(() => flattenLocationTree(treeQuery.data ?? []), [treeQuery.data]);

  const parentLevel = PARENT_LEVEL[locationLevel];
  const parentOptions = useMemo<readonly SelectOption[]>(
    () =>
      parentLevel === null
        ? []
        : flatTree
            .filter((node) => node.level === parentLevel)
            .map((node) => ({ value: node.id, label: node.label })),
    [flatTree, parentLevel],
  );
  const selectedParentNode = useMemo(
    () => flatTree.find((node) => node.id === locationParentId) ?? null,
    [flatTree, locationParentId],
  );

  const locations = useMemo(
    () =>
      (locationsQuery.data?.items ?? []).filter(
        (location) =>
          location.warehouseId === undefined ||
          selectedWarehouseId === null ||
          location.warehouseId === selectedWarehouseId,
      ),
    [locationsQuery.data, selectedWarehouseId],
  );

  const invalidateWarehouses = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.warehouses.list });
  };

  const invalidateLocations = (): void => {
    if (selectedWarehouseId === null) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.warehouses.locations(selectedWarehouseId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.warehouses.tree(selectedWarehouseId) });
  };

  const createWarehouseMutation = useMutation({
    mutationFn: (payload: CreateWarehousePayload) =>
      api.post<WarehouseRecord>('/warehouses', payload, { idempotencyKey: newRequestId() }),
    onSuccess: (warehouse) => {
      toast.success('انبار ایجاد شد', `${warehouse.name} (${warehouse.code})`);
      setWarehouseModalOpen(false);
      setEditingWarehouse(null);
      setPage(1);
      setSearch('');
      setStatusFilter('');
      setSelectedWarehouse(warehouse);
      invalidateWarehouses();
    },
    onError: (error) => toast.error('ایجاد انبار ناموفق بود', toFaErrorMessage(error)),
  });

  const updateWarehouseMutation = useMutation({
    mutationFn: ({ id, payload }: { readonly id: string; readonly payload: UpdateWarehousePayload }) =>
      api.patch<WarehouseRecord>(`/warehouses/${id}`, payload),
    onSuccess: (warehouse) => {
      toast.success('انبار به‌روزرسانی شد', `${warehouse.name} (${warehouse.code})`);
      setWarehouseModalOpen(false);
      setEditingWarehouse(null);
      setSelectedWarehouse((current) => (current?.id === warehouse.id ? warehouse : current));
      invalidateWarehouses();
    },
    onError: (error) => toast.error('به‌روزرسانی انبار ناموفق بود', toFaErrorMessage(error)),
  });

  const deleteWarehouseMutation = useMutation({
    mutationFn: (warehouse: WarehouseRecord) => api.del<void>(`/warehouses/${warehouse.id}`),
    onSuccess: (_result, warehouse) => {
      toast.success('انبار حذف شد', `${warehouse.name} (${warehouse.code})`);
      setWarehouseDeleteTarget(null);
      setSelectedWarehouse((current) => (current?.id === warehouse.id ? null : current));
      invalidateWarehouses();
    },
    onError: (error) => toast.error('حذف انبار ناموفق بود', toFaErrorMessage(error)),
  });

  const createLocationMutation = useMutation({
    mutationFn: (payload: CreateLocationPayload) =>
      api.post<WarehouseLocation>(`/warehouses/${selectedWarehouseId ?? ''}/locations`, payload, {
        idempotencyKey: newRequestId(),
      }),
    onSuccess: (location) => {
      toast.success(
        'موقعیت ایجاد شد',
        location.fullCode ?? location.code,
      );
      setLocationCreateOpen(false);
      setLocationAttempted(false);
      invalidateLocations();
    },
    onError: (error) => toast.error('ایجاد موقعیت ناموفق بود', toFaErrorMessage(error)),
  });

  const updateLocationMutation = useMutation({
    mutationFn: ({ id, payload }: { readonly id: string; readonly payload: UpdateLocationPayload }) =>
      api.patch<WarehouseLocation>(`/locations/${id}`, payload),
    onSuccess: (location) => {
      toast.success('موقعیت به‌روزرسانی شد', location.code);
      setLocationEditTarget(null);
      setEditLocationAttempted(false);
      invalidateLocations();
    },
    onError: (error) => toast.error('به‌روزرسانی موقعیت ناموفق بود', toFaErrorMessage(error)),
  });

  const deleteLocationMutation = useMutation({
    mutationFn: (location: WarehouseLocation) => api.del<void>(`/locations/${location.id}`),
    onSuccess: (_result, location) => {
      toast.success('موقعیت حذف شد', location.code);
      setLocationDeleteTarget(null);
      invalidateLocations();
    },
    onError: (error) => toast.error('حذف موقعیت ناموفق بود', toFaErrorMessage(error)),
  });

  const warehouseCodeValid =
    warehouseCode.trim().length > 0 && /^[A-Z0-9][A-Z0-9_-]*$/i.test(warehouseCode.trim());
  const warehouseNameValid = warehouseName.trim().length > 0;
  const warehouseCodeError =
    warehouseAttempted && !warehouseCodeValid
      ? 'کد انبار باید با حرف یا رقم شروع شود و فقط شامل حروف، رقم، خط تیره و زیرخط باشد.'
      : undefined;
  const warehouseNameError =
    warehouseAttempted && !warehouseNameValid ? 'نام انبار الزامی است.' : undefined;

  const locationCodeValid =
    locationCode.trim().length > 0 && /^[A-Z0-9][A-Z0-9_-]{0,19}$/i.test(locationCode.trim());
  const locationCodeError =
    locationAttempted && !locationCodeValid
      ? 'کد موقعیت الزامی است و حداکثر ۲۰ نویسهٔ حرف، رقم، خط تیره یا زیرخط دارد.'
      : undefined;
  const locationParentError =
    locationAttempted && parentLevel !== null && locationParentId === ''
      ? `برای این سطح، انتخاب ${LOCATION_LEVEL_LABELS[parentLevel]} والد الزامی است.`
      : undefined;
  const locationPriorityValue = Number(locationPriority);
  const locationPriorityError =
    locationAttempted &&
    (!Number.isFinite(locationPriorityValue) ||
      !Number.isInteger(locationPriorityValue) ||
      locationPriorityValue < 0)
      ? 'اولویت برداشت باید یک عدد صحیح نامنفی باشد.'
      : undefined;
  const editLocationPriorityValue = Number(editLocationPriority);
  const editLocationPriorityError =
    editLocationAttempted &&
    (!Number.isFinite(editLocationPriorityValue) ||
      !Number.isInteger(editLocationPriorityValue) ||
      editLocationPriorityValue < 0)
      ? 'اولویت برداشت باید یک عدد صحیح نامنفی باشد.'
      : undefined;

  const openCreateWarehouse = (): void => {
    setEditingWarehouse(null);
    setWarehouseCode('');
    setWarehouseName('');
    setWarehouseType('main');
    setWarehouseCity('');
    setWarehouseAddress('');
    setWarehouseStatus('active');
    setWarehouseAttempted(false);
    setWarehouseModalOpen(true);
  };

  const openEditWarehouse = (warehouse: WarehouseRecord): void => {
    setEditingWarehouse(warehouse);
    setWarehouseCode(warehouse.code);
    setWarehouseName(warehouse.name);
    setWarehouseType(normalizeWarehouseType(warehouse.type));
    setWarehouseCity(warehouse.city ?? '');
    setWarehouseAddress(warehouse.address ?? '');
    setWarehouseStatus(warehouse.status === 'inactive' ? 'inactive' : 'active');
    setWarehouseAttempted(false);
    setWarehouseModalOpen(true);
  };

  const submitWarehouse = (): void => {
    setWarehouseAttempted(true);
    if (!warehouseCodeValid || !warehouseNameValid) {
      return;
    }
    if (editingWarehouse !== null) {
      updateWarehouseMutation.mutate({
        id: editingWarehouse.id,
        payload: {
          name: warehouseName.trim(),
          city: warehouseCity.trim(),
          address: warehouseAddress.trim(),
          status: warehouseStatus,
        },
      });
      return;
    }
    createWarehouseMutation.mutate({
      code: warehouseCode.trim().toUpperCase(),
      name: warehouseName.trim(),
      type: warehouseType,
      city: warehouseCity.trim(),
      address: warehouseAddress.trim(),
    });
  };

  const openLocationCreate = (
    level: LocationNodeLevel = 'location',
    parentId = '',
  ): void => {
    setLocationCode('');
    setLocationName('');
    setLocationLevel(level);
    setLocationParentId(parentId);
    setLocationUsage('bin');
    setLocationCapacity('');
    setLocationBarcode('');
    setLocationPriority('0');
    setLocationIsPickFace(true);
    setLocationAttempted(false);
    setLocationCreateOpen(true);
  };

  const submitLocationCreate = (): void => {
    setLocationAttempted(true);
    const priority = Number(locationPriority);
    const priorityValid =
      Number.isFinite(priority) && Number.isInteger(priority) && priority >= 0;
    if (
      selectedWarehouseId === null ||
      !locationCodeValid ||
      (parentLevel !== null && locationParentId === '') ||
      !priorityValid
    ) {
      return;
    }
    const payload: CreateLocationPayload = {
      code: locationCode.trim().toUpperCase(),
      type: locationLevel,
      ...(locationName.trim() === '' ? {} : { name: locationName.trim() }),
      ...(parentLevel === null || locationParentId === '' ? {} : { parentId: locationParentId }),
      pickPriority: priority,
      ...(locationLevel === 'location'
        ? {
            locationType: locationUsage,
            ...(locationBarcode.trim() === '' ? {} : { barcode: locationBarcode.trim() }),
          }
        : {}),
      ...(locationLevel === 'bin'
        ? {
            isPickFace: locationIsPickFace,
            ...(locationCapacity.trim() === '' ? {} : { capacity: locationCapacity.trim() }),
          }
        : {}),
    };
    createLocationMutation.mutate(payload);
  };

  const openLocationEdit = (location: WarehouseLocation): void => {
    setLocationEditTarget(location);
    setEditLocationBarcode(location.barcode ?? '');
    setEditLocationPriority(String(location.pickPriority ?? 0));
    setEditLocationPickable(location.isPickable ?? true);
    setEditLocationStatus(location.status === 'inactive' ? 'inactive' : 'active');
    setEditLocationAttempted(false);
  };

  const submitLocationEdit = (): void => {
    setEditLocationAttempted(true);
    const priority = Number(editLocationPriority);
    const priorityValid =
      Number.isFinite(priority) && Number.isInteger(priority) && priority >= 0;
    if (locationEditTarget === null || !priorityValid) {
      return;
    }
    updateLocationMutation.mutate({
      id: locationEditTarget.id,
      payload: {
        barcode: editLocationBarcode.trim(),
        pickPriority: priority,
        isPickable: editLocationPickable,
        status: editLocationStatus,
      },
    });
  };

  if (!canRead) {
    return (
      <>
        <PageHeader title="انبارها و موقعیت‌ها" />
        <PermissionNotice permission={PERM.warehouseRead} />
      </>
    );
  }

  const warehouseColumns: readonly Column<WarehouseRecord>[] = [
    {
      key: 'code',
      header: 'کد',
      sortable: true,
      render: (warehouse) => (
        <span dir="ltr" className="font-mono text-xs text-slate-700 dark:text-slate-200">
          {warehouse.code}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'نام',
      sortable: true,
      render: (warehouse) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-slate-900 dark:text-slate-100">{warehouse.name}</span>
          {selectedWarehouse?.id === warehouse.id && <Badge tone="brand">انتخاب‌شده</Badge>}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'نوع',
      render: (warehouse) => <Badge tone="info">{warehouseTypeLabel(warehouse.type)}</Badge>,
    },
    {
      key: 'city',
      header: 'شهر',
      render: (warehouse) => warehouse.city ?? '—',
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (warehouse) => <StatusBadge status={warehouse.status ?? 'active'} />,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (warehouse) => (
        <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
          {canReadLocations && (
            <Button
              size="sm"
              variant="outline"
              icon={<MapPin aria-hidden className="size-3.5" />}
              onClick={() => setSelectedWarehouse(warehouse)}
            >
              موقعیت‌ها
            </Button>
          )}
          {canUpdate && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil aria-hidden className="size-3.5" />}
              onClick={() => openEditWarehouse(warehouse)}
            >
              ویرایش
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
              icon={<Trash2 aria-hidden className="size-3.5" />}
              onClick={() => setWarehouseDeleteTarget(warehouse)}
            >
              حذف
            </Button>
          )}
        </span>
      ),
    },
  ];

  const locationColumns: readonly Column<WarehouseLocation>[] = [
    {
      key: 'code',
      header: 'کد موقعیت',
      sortable: true,
      render: (location) => (
        <span dir="ltr" className="font-mono text-xs text-slate-700 dark:text-slate-200">
          {location.fullCode ?? location.code}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'کاربرد',
      render: (location) => <Badge tone="info">{locationUsageLabel(location.type)}</Badge>,
    },
    {
      key: 'status',
      header: 'وضعیت',
      render: (location) => <StatusBadge status={location.status ?? 'active'} />,
    },
    {
      key: 'pickable',
      header: 'قابل برداشت',
      align: 'center',
      render: (location) =>
        location.isPickable === false ? (
          <Badge tone="neutral">خیر</Badge>
        ) : (
          <Badge tone="success">بله</Badge>
        ),
    },
    {
      key: 'priority',
      header: 'اولویت برداشت',
      align: 'center',
      render: (location) => location.pickPriority ?? 0,
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (location) => (
        <span className="flex items-center gap-1">
          {canUpdateLocations && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil aria-hidden className="size-3.5" />}
              onClick={() => openLocationEdit(location)}
            >
              ویرایش
            </Button>
          )}
          {canDeleteLocations && (
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
              icon={<Trash2 aria-hidden className="size-3.5" />}
              onClick={() => setLocationDeleteTarget(location)}
            >
              حذف
            </Button>
          )}
        </span>
      ),
    },
  ];

  const treeColumns: readonly Column<FlatLocationNode>[] = [
    {
      key: 'level',
      header: 'سطح',
      render: (node) => (
        <Badge tone={locationLevelTone(node.level)}>{LOCATION_LEVEL_LABELS[node.level]}</Badge>
      ),
    },
    {
      key: 'code',
      header: 'کد',
      render: (node) => (
        <span
          className="inline-flex items-center gap-2"
          style={{ paddingInlineStart: `${node.depth * 16}px` }}
        >
          {node.depth > 0 && (
            <span aria-hidden className="text-slate-300 dark:text-slate-600">
              ↳
            </span>
          )}
          <span
            dir="ltr"
            className="font-mono text-xs text-slate-700 dark:text-slate-200"
          >
            {node.code}
          </span>
          {node.name !== undefined && node.name !== '' && (
            <span className="text-xs text-slate-500 dark:text-slate-400">{node.name}</span>
          )}
        </span>
      ),
    },
    {
      key: 'parent',
      header: 'کد والد',
      render: (node) =>
        node.parentCode === null ? (
          '—'
        ) : (
          <span dir="ltr" className="font-mono text-xs text-slate-500 dark:text-slate-400">
            {node.parentCode}
          </span>
        ),
    },
    {
      key: 'capacity',
      header: 'ظرفیت',
      align: 'center',
      render: (node) =>
        node.capacityQuantity === null ? (
          '—'
        ) : (
          <span className="tabular">{formatQuantity(node.capacityQuantity)}</span>
        ),
    },
    {
      key: 'priority',
      header: 'اولویت برداشت',
      align: 'center',
      render: (node) =>
        node.pickPriority === null ? (
          '—'
        ) : (
          <span className="tabular">{node.pickPriority.toLocaleString('fa-IR')}</span>
        ),
    },
    {
      key: 'actions',
      header: 'عملیات',
      render: (node) => {
        const childLevel = childLevelOf(node.level);
        if (childLevel === null || !canCreateLocations) {
          return <span className="text-xs text-slate-400">—</span>;
        }
        return (
          <Button
            size="sm"
            variant="outline"
            icon={<Plus aria-hidden className="size-3.5" />}
            onClick={() => openLocationCreate(childLevel, node.id)}
          >
            افزودن زیرمجموعه
          </Button>
        );
      },
    },
  ];

  const creatingWarehouse = editingWarehouse === null;
  const total = warehousesQuery.data?.pagination?.total;
  const totalPages = warehousesQuery.data?.pagination?.totalPages;

  return (
    <>
      <PageHeader
        title="انبارها و موقعیت‌ها"
        description="مدیریت انبارها و ساختار موقعیت‌های انبار (ناحیه، راهرو، رَک، طبقه، بین و موقعیت)"
        breadcrumbs={[{ label: 'انبار', to: '/inventory' }, { label: 'انبارها و موقعیت‌ها' }]}
        actions={
          canCreate ? (
            <Button icon={<Plus aria-hidden className="size-4" />} onClick={openCreateWarehouse}>
              انبار جدید
            </Button>
          ) : undefined
        }
      />

      <DataTableToolbar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="جستجوی نام یا کد انبار…"
        filters={
          <Select
            aria-label="فیلتر وضعیت انبار"
            options={WAREHOUSE_STATUS_FILTER_OPTIONS}
            value={statusFilter}
            className="w-36"
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
          />
        }
        onRefresh={() => void warehousesQuery.refetch()}
        refreshing={warehousesQuery.isFetching}
      />

      <DataTable
        columns={warehouseColumns}
        rows={warehousesQuery.data?.items ?? []}
        rowKey={(warehouse) => warehouse.id}
        loading={warehousesQuery.isLoading}
        error={warehousesQuery.isError ? warehousesQuery.error : undefined}
        onRetry={() => void warehousesQuery.refetch()}
        onRowClick={(warehouse) => setSelectedWarehouse(warehouse)}
        caption="فهرست انبارها"
        emptyTitle="انباری یافت نشد"
        emptyDescription="با تغییر جستجو دوباره تلاش کنید یا یک انبار جدید بسازید."
        emptyAction={
          canCreate ? (
            <Button icon={<Plus aria-hidden className="size-4" />} onClick={openCreateWarehouse}>
              انبار جدید
            </Button>
          ) : undefined
        }
      />

      {total !== undefined || totalPages !== undefined ? (
        <Pagination
          mode="offset"
          page={page}
          perPage={50}
          {...(total === undefined ? {} : { total })}
          {...(totalPages === undefined ? {} : { totalPages })}
          onPageChange={setPage}
          disabled={warehousesQuery.isFetching}
        />
      ) : null}

      {selectedWarehouse === null ? (
        <Card className="mt-5">
          <EmptyState
            icon={<WarehouseIcon className="size-9" />}
            title="انباری انتخاب نشده است"
            description="روی یک ردیف از جدول انبارها بزنید یا دکمهٔ «موقعیت‌ها» را انتخاب کنید تا ساختار و موقعیت‌های موجودی آن نمایش داده شود."
          />
        </Card>
      ) : !canReadLocations ? (
        <Card className="mt-5">
          <PermissionNotice permission={PERM.locationRead} />
        </Card>
      ) : (
        <>
          <Card className="mt-5">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <Layers aria-hidden className="size-4 text-brand-700 dark:text-brand-300" />
                  ساختار انبار
                </span>
              }
              description={`${selectedWarehouse.name} — ${selectedWarehouse.code} · ${flatTree.length.toLocaleString('fa-IR')} گره در ساختار`}
              actions={
                canCreateLocations ? (
                  <Button
                    size="sm"
                    icon={<Plus aria-hidden className="size-4" />}
                    onClick={() => openLocationCreate('zone')}
                  >
                    افزودن ناحیه
                  </Button>
                ) : undefined
              }
            />
            <DataTable
              columns={treeColumns}
              rows={flatTree}
              rowKey={(node) => node.id}
              loading={treeQuery.isLoading}
              error={treeQuery.isError ? treeQuery.error : undefined}
              onRetry={() => void treeQuery.refetch()}
              caption={`ساختار انبار ${selectedWarehouse.name}`}
              emptyTitle="ساختار انبار هنوز ایجاد نشده است"
              emptyDescription="برای شروع اولین ناحیه (Zone) را بسازید؛ سپس با «افزودن زیرمجموعه» هر ردیف، راهرو، رَک، طبقه، بین و موقعیت برگ را اضافه کنید."
              emptyAction={
                canCreateLocations ? (
                  <Button
                    icon={<Plus aria-hidden className="size-4" />}
                    onClick={() => openLocationCreate('zone')}
                  >
                    افزودن اولین ناحیه
                  </Button>
                ) : undefined
              }
            />
          </Card>

          <Card className="mt-5">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <MapPin aria-hidden className="size-4 text-brand-700 dark:text-brand-300" />
                  موقعیت‌های موجودی
                </span>
              }
              description={`${locations.length.toLocaleString('fa-IR')} موقعیت برگ برای ${selectedWarehouse.name}`}
              actions={
                canCreateLocations ? (
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Plus aria-hidden className="size-4" />}
                    onClick={() => openLocationCreate('location')}
                  >
                    افزودن موقعیت
                  </Button>
                ) : undefined
              }
            />
            <DataTable
              columns={locationColumns}
              rows={locations}
              rowKey={(location) => location.id}
              loading={locationsQuery.isLoading}
              error={locationsQuery.isError ? locationsQuery.error : undefined}
              onRetry={() => void locationsQuery.refetch()}
              caption={`موقعیت‌های ${selectedWarehouse.name}`}
              emptyTitle="موقعیت برگ برای این انبار ثبت نشده است"
              emptyDescription="بعد از ساخت زنجیرهٔ ناحیه ← راهرو ← رَک ← طبقه ← بین، یک موقعیت برگ بسازید تا موجودی قابل نگهداری شود."
              emptyAction={
                canCreateLocations ? (
                  <Button
                    icon={<Plus aria-hidden className="size-4" />}
                    onClick={() => openLocationCreate('location')}
                  >
                    افزودن موقعیت
                  </Button>
                ) : undefined
              }
            />
          </Card>
        </>
      )}

      <Modal
        open={warehouseModalOpen}
        onClose={() => {
          setWarehouseModalOpen(false);
          setEditingWarehouse(null);
        }}
        title={creatingWarehouse ? 'ایجاد انبار' : 'ویرایش انبار'}
        description={
          creatingWarehouse
            ? 'کد انبار پس از ایجاد قابل تغییر نیست.'
            : 'کد و نوع انبار پس از ایجاد قابل تغییر نیستند.'
        }
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setWarehouseModalOpen(false);
                setEditingWarehouse(null);
              }}
              disabled={createWarehouseMutation.isPending || updateWarehouseMutation.isPending}
            >
              انصراف
            </Button>
            <Button
              loading={createWarehouseMutation.isPending || updateWarehouseMutation.isPending}
              onClick={submitWarehouse}
            >
              {creatingWarehouse ? 'ایجاد انبار' : 'ذخیره تغییرات'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="کد انبار" htmlFor="warehouse-code" required error={warehouseCodeError}>
            <Input
              id="warehouse-code"
              dir="ltr"
              className="text-left font-mono"
              value={warehouseCode}
              disabled={!creatingWarehouse}
              invalid={warehouseCodeError !== undefined}
              onChange={(event) => setWarehouseCode(event.target.value)}
              placeholder="WH-MAIN"
            />
          </FormField>

          <FormField label="نام انبار" htmlFor="warehouse-name" required error={warehouseNameError}>
            <Input
              id="warehouse-name"
              value={warehouseName}
              invalid={warehouseNameError !== undefined}
              onChange={(event) => setWarehouseName(event.target.value)}
              placeholder="انبار مرکزی"
            />
          </FormField>

          <FormField
            label="نوع انبار"
            htmlFor="warehouse-type"
            hint={creatingWarehouse ? undefined : 'نوع انبار پس از ایجاد قابل تغییر نیست.'}
          >
            <Select
              id="warehouse-type"
              options={WAREHOUSE_TYPE_OPTIONS}
              value={warehouseType}
              disabled={!creatingWarehouse}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'main' || value === 'transit' || value === 'return') {
                  setWarehouseType(value);
                }
              }}
            />
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="شهر" htmlFor="warehouse-city">
              <Input
                id="warehouse-city"
                value={warehouseCity}
                onChange={(event) => setWarehouseCity(event.target.value)}
                placeholder="تهران"
              />
            </FormField>
            {!creatingWarehouse && (
              <FormField label="وضعیت" htmlFor="warehouse-status">
                <Select
                  id="warehouse-status"
                  options={WAREHOUSE_STATUS_OPTIONS}
                  value={warehouseStatus}
                  onChange={(event) => {
                    if (isWarehouseStatus(event.target.value)) {
                      setWarehouseStatus(event.target.value);
                    }
                  }}
                />
              </FormField>
            )}
          </div>

          <FormField label="نشانی" htmlFor="warehouse-address" hint="اختیاری، حداکثر ۱۰۰۰ نویسه">
            <Textarea
              id="warehouse-address"
              rows={3}
              value={warehouseAddress}
              onChange={(event) => setWarehouseAddress(event.target.value)}
              placeholder="نشانی کامل انبار…"
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        open={locationCreateOpen}
        onClose={() => setLocationCreateOpen(false)}
        title={selectedParentNode === null ? 'ایجاد موقعیت انبار' : 'افزودن زیرمجموعه'}
        description={
          selectedParentNode === null
            ? 'سطح موردنظر و والد آن را انتخاب کنید. کد موقعیت برگ از زنجیرهٔ والدین ساخته می‌شود.'
            : `سطح «${LOCATION_LEVEL_LABELS[locationLevel]}» زیر «${selectedParentNode.fullCode ?? selectedParentNode.label}» ساخته می‌شود؛ والد را می‌توانید تغییر دهید.`
        }
        size="lg"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setLocationCreateOpen(false)}
              disabled={createLocationMutation.isPending}
            >
              انصراف
            </Button>
            <Button loading={createLocationMutation.isPending} onClick={submitLocationCreate}>
              ایجاد موقعیت
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="سطح موقعیت" htmlFor="location-level" required>
              <Select
                id="location-level"
                options={LOCATION_LEVEL_OPTIONS}
                value={locationLevel}
                onChange={(event) => {
                  if (isLocationNodeLevel(event.target.value)) {
                    setLocationLevel(event.target.value);
                    setLocationParentId('');
                  }
                }}
              />
            </FormField>

            <FormField
              label={`والد (${parentLevel === null ? 'ندارد' : LOCATION_LEVEL_LABELS[parentLevel]})`}
              htmlFor="location-parent"
              required={parentLevel !== null}
              error={locationParentError}
              hint={
                parentLevel === null
                  ? 'ناحیه سطح ریشه است و والد ندارد.'
                  : treeQuery.isLoading
                    ? 'در حال دریافت ساختار انبار…'
                    : parentOptions.length === 0
                      ? `هنوز ${LOCATION_LEVEL_LABELS[parentLevel]} برای این انبار ثبت نشده است. ابتدا سطح والد را ایجاد کنید.`
                      : undefined
              }
            >
              <Select
                id="location-parent"
                options={parentOptions}
                placeholder={
                  parentLevel === null ? 'نیاز به والد نیست' : 'انتخاب والد…'
                }
                value={locationParentId}
                disabled={parentLevel === null || treeQuery.isLoading || parentOptions.length === 0}
                invalid={locationParentError !== undefined}
                onChange={(event) => setLocationParentId(event.target.value)}
              />
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="کد" htmlFor="location-code" required error={locationCodeError}>
              <Input
                id="location-code"
                dir="ltr"
                className="text-left font-mono"
                value={locationCode}
                invalid={locationCodeError !== undefined}
                onChange={(event) => setLocationCode(event.target.value)}
                placeholder="A-01"
              />
            </FormField>
            <FormField label="نام" htmlFor="location-name" hint="اختیاری">
              <Input
                id="location-name"
                value={locationName}
                onChange={(event) => setLocationName(event.target.value)}
                placeholder="ناحیهٔ اصلی"
              />
            </FormField>
          </div>

          {locationLevel === 'location' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="کاربرد موقعیت" htmlFor="location-usage" required>
                <Select
                  id="location-usage"
                  options={LOCATION_USAGE_OPTIONS}
                  value={locationUsage}
                  onChange={(event) => {
                    const value = event.target.value;
                    if ((LOCATION_USAGES as readonly string[]).includes(value)) {
                      setLocationUsage(value as LocationUsage);
                    }
                  }}
                />
              </FormField>
              <FormField label="بارکد" htmlFor="location-barcode" hint="خالی یعنی همان کد کامل موقعیت">
                <Input
                  id="location-barcode"
                  dir="ltr"
                  className="text-left font-mono"
                  value={locationBarcode}
                  onChange={(event) => setLocationBarcode(event.target.value)}
                  placeholder="A-01-R1-2-07"
                />
              </FormField>
            </div>
          )}

          {locationLevel === 'bin' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="ظرفیت" htmlFor="location-capacity" hint="اختیاری، بر حسب واحد پایه">
                <Input
                  id="location-capacity"
                  dir="ltr"
                  className="text-left"
                  inputMode="decimal"
                  value={locationCapacity}
                  onChange={(event) => setLocationCapacity(event.target.value)}
                  placeholder="1000"
                />
              </FormField>
              <div className="flex items-end pb-2">
                <Checkbox
                  id="location-pick-face"
                  label="محل برداشت (Pick Face)"
                  checked={locationIsPickFace}
                  onChange={(event) => setLocationIsPickFace(event.target.checked)}
                />
              </div>
            </div>
          )}

          <FormField
            label="اولویت برداشت"
            htmlFor="location-priority"
            hint="عدد کوچک‌تر زودتر برداشت می‌شود."
            error={locationPriorityError}
          >
            <Input
              id="location-priority"
              dir="ltr"
              className="text-left"
              inputMode="numeric"
              value={locationPriority}
              invalid={locationPriorityError !== undefined}
              onChange={(event) => setLocationPriority(event.target.value)}
            />
          </FormField>

          {treeQuery.isError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              دریافت ساختار موقعیت‌ها ناموفق بود؛ برای انتخاب والد دوباره تلاش کنید.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={locationEditTarget !== null}
        onClose={() => setLocationEditTarget(null)}
        title="ویرایش موقعیت"
        description={locationEditTarget?.code}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setLocationEditTarget(null)}
              disabled={updateLocationMutation.isPending}
            >
              انصراف
            </Button>
            <Button loading={updateLocationMutation.isPending} onClick={submitLocationEdit}>
              ذخیره تغییرات
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField
            label="بارکد"
            htmlFor="edit-location-barcode"
            hint="خالی یعنی همان کد کامل موقعیت"
          >
            <Input
              id="edit-location-barcode"
              dir="ltr"
              className="text-left font-mono"
              value={editLocationBarcode}
              onChange={(event) => setEditLocationBarcode(event.target.value)}
            />
          </FormField>

          <FormField
            label="اولویت برداشت"
            htmlFor="edit-location-priority"
            error={editLocationPriorityError}
            hint="عدد کوچک‌تر زودتر برداشت می‌شود."
          >
            <Input
              id="edit-location-priority"
              dir="ltr"
              className="text-left"
              inputMode="numeric"
              value={editLocationPriority}
              invalid={editLocationPriorityError !== undefined}
              onChange={(event) => setEditLocationPriority(event.target.value)}
            />
          </FormField>

          <FormField label="وضعیت" htmlFor="edit-location-status">
            <Select
              id="edit-location-status"
              options={WAREHOUSE_STATUS_OPTIONS}
              value={editLocationStatus}
              onChange={(event) => {
                if (isWarehouseStatus(event.target.value)) {
                  setEditLocationStatus(event.target.value);
                }
              }}
            />
          </FormField>

          <Checkbox
            id="edit-location-pickable"
            label="قابل برداشت"
            description="اگر خاموش باشد، این موقعیت در پیشنهادهای برداشت استفاده نمی‌شود."
            checked={editLocationPickable}
            onChange={(event) => setEditLocationPickable(event.target.checked)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={warehouseDeleteTarget !== null}
        title="حذف انبار"
        description={
          warehouseDeleteTarget === null
            ? undefined
            : `آیا از حذف «${warehouseDeleteTarget.name}» (${warehouseDeleteTarget.code}) مطمئن هستید؟ انباری که موجودی دارد قابل حذف نیست.`
        }
        confirmLabel="حذف انبار"
        tone="danger"
        loading={deleteWarehouseMutation.isPending}
        onConfirm={() => {
          if (warehouseDeleteTarget !== null) {
            deleteWarehouseMutation.mutate(warehouseDeleteTarget);
          }
        }}
        onCancel={() => setWarehouseDeleteTarget(null)}
      />

      <ConfirmDialog
        open={locationDeleteTarget !== null}
        title="حذف موقعیت"
        description={
          locationDeleteTarget === null
            ? undefined
            : `آیا از حذف موقعیت «${locationDeleteTarget.code}» مطمئن هستید؟`
        }
        confirmLabel="حذف موقعیت"
        tone="danger"
        loading={deleteLocationMutation.isPending}
        onConfirm={() => {
          if (locationDeleteTarget !== null) {
            deleteLocationMutation.mutate(locationDeleteTarget);
          }
        }}
        onCancel={() => setLocationDeleteTarget(null)}
      />
    </>
  );
}
