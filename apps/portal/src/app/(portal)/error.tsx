'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/states';

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="p-6">
      <ErrorState code="RENDER_ERROR" message={error.message || 'unexpected portal error'} requestId={error.digest} />
      <button
        onClick={reset}
        className="mt-4 h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
      >
        Retry
      </button>
    </div>
  );
}
