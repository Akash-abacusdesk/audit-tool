import { Topbar } from '@/components/shell/topbar';
import { PageHeader } from '@/components/ui/states';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { apiFetch, ApiRequestError } from '@/lib/api';

async function apiReadiness(): Promise<{ ok: boolean; label: string }> {
  try {
    const data = await apiFetch<{ status: string }>('/readyz');
    return { ok: true, label: data.status };
  } catch (err) {
    const code = err instanceof ApiRequestError ? err.code : 'UNKNOWN';
    return { ok: false, label: code };
  }
}

export default async function OverviewPage() {
  const readiness = await apiReadiness();
  return (
    <>
      <Topbar trail={['Overview']} />
      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        <PageHeader
          title="Overview"
          description="Fleet posture at a glance. Findings, tasks and update pipelines arrive in Sections 2–4."
        />
        <div className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>API status</CardTitle>
              <StatusBadge ok={readiness.ok} label={readiness.label} />
            </CardHeader>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Readiness via <code className="font-mono text-[11px]">GET /readyz</code>, response
              envelope per docs/api-conventions.md.
            </p>
          </Card>
        </div>
        <EmptyState
          title="Feature surfaces are on their way"
          description="This view proves the shell renders end-to-end; findings kanban, task boards and update pipelines ship with their own sections."
        />
      </main>
    </>
  );
}
