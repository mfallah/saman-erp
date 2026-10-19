import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api-client';
import { queryKeys } from './query-keys';
import { PERM } from './permissions';
import { useHasPermission } from './use-auth';
import type { FiscalPeriod, FiscalYear } from '../types/api';

export interface FiscalPeriodSelection {
  readonly years: readonly FiscalYear[];
  readonly periods: readonly FiscalPeriod[];
  readonly yearId: string;
  readonly periodId: string;
  readonly setYearId: (id: string) => void;
  readonly setPeriodId: (id: string) => void;
  readonly loading: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * Fiscal year/period selector shared by accounting screens. Defaults to the
 * first year returned and its first open period; a period may be left empty
 * (the API then aggregates the whole year).
 */
export function useFiscalPeriodSelection(): FiscalPeriodSelection {
  const canRead = useHasPermission(PERM.fiscalYearRead);
  const [yearId, setYearIdState] = useState('');
  const [periodId, setPeriodIdState] = useState('');

  const query = useQuery({
    queryKey: queryKeys.accounting.fiscalYears,
    queryFn: () => api.get<readonly FiscalYear[]>('/accounting/fiscal-years', { perPage: 50 }),
    enabled: canRead,
    staleTime: 5 * 60_000,
  });

  const years = query.data ?? [];
  const activeYearId = yearId !== '' ? yearId : (years[0]?.id ?? '');
  const year = years.find((candidate) => candidate.id === activeYearId);
  const periods = year?.periods ?? [];
  const defaultPeriod = periods.find((period) => period.status === 'open') ?? periods[0];
  const activePeriodId = periodId !== '' ? periodId : (defaultPeriod?.id ?? '');

  return {
    years,
    periods,
    yearId: activeYearId,
    periodId: activePeriodId,
    setYearId: (id: string) => {
      setYearIdState(id);
      setPeriodIdState('');
    },
    setPeriodId: setPeriodIdState,
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
