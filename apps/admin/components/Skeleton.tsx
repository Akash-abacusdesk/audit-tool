export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="surface divide-y divide-[var(--color-border)] overflow-hidden">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <div className="skeleton h-5 w-16" />
          <div className="skeleton h-4 flex-1" />
          <div className="skeleton h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
