'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { OverviewDto } from '@platform/shared';
import { apiFetch } from './api';

interface OverviewState {
  data: OverviewDto | null;
  refresh: () => Promise<void>;
}
const OverviewContext = createContext<OverviewState | null>(null);

/** Console-wide aggregates (nav counters + the Overview page). Refreshed on mount, every 30s, and on demand. */
export function OverviewProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<OverviewDto | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(await apiFetch<OverviewDto>('/overview'));
    } catch {
      // counters are decoration; the page that needs the data reports its own errors
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);
  const value = useMemo(() => ({ data, refresh }), [data, refresh]);
  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

export function useOverview(): OverviewState {
  const c = useContext(OverviewContext);
  if (!c) throw new Error('useOverview outside OverviewProvider');
  return c;
}
