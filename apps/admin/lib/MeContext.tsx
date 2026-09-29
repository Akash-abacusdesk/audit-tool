'use client';

import { createContext, useContext } from 'react';
import type { MeResponse } from '@platform/shared';

export const MeContext = createContext<MeResponse | null>(null);

/** Only valid inside (app)/layout.tsx's subtree, where MeContext is always populated. */
export function useMeContext(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMeContext used outside the authenticated app shell');
  return me;
}
