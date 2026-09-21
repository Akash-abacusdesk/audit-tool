import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-32 w-full max-w-md" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
