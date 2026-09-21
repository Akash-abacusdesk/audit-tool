import { Topbar } from '@/components/shell/topbar';
import { PageHeader, SEVERITIES } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { Badge, SeverityBadge, StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/ui/states';
import type { Severity } from '@/lib/severity';

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="rounded-xl border border-border bg-card/40 p-4">
        <div className="space-y-4">{children}</div>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const TOKEN_SWATCHES: { name: string; className: string }[] = [
  { name: 'background', className: 'bg-background' },
  { name: 'surface', className: 'bg-surface' },
  { name: 'muted', className: 'bg-muted' },
  { name: 'card', className: 'bg-card' },
  { name: 'primary', className: 'bg-primary' },
  { name: 'success', className: 'bg-success' },
  { name: 'destructive', className: 'bg-destructive' },
];

export default function DesignSystemPage() {
  return (
    <>
      <Topbar trail={['Design System']} />
      <main className="mx-auto w-full max-w-5xl space-y-10 overflow-y-auto p-6">
        <PageHeader
          title="Design System"
          description="Living specification for the portal: tokens, primitives and their states. Severity colors map 1:1 onto the D3 normalized scale (docs/scanning/SCANNING-CONVENTIONS.md §3)."
        />

        <Section title="Color tokens" hint="Semantic palette — dark theme shown by default.">
          <div className="flex flex-wrap gap-2">
            {TOKEN_SWATCHES.map((s) => (
              <figure key={s.name} className="space-y-1.5">
                <span className={`block h-10 w-16 rounded-lg border border-border ${s.className}`} />
                <figcaption className="text-[11px] text-muted-foreground">{s.name}</figcaption>
              </figure>
            ))}
          </div>
          <Row label="severity">
            {SEVERITIES.map((s) => (
              <SeverityBadge key={s} severity={s} />
            ))}
          </Row>
        </Section>

        <Section title="Typography" hint="One system family, fixed rem ramp, tabular figures in data.">
          <div className="space-y-2">
            <p className="text-lg font-semibold tracking-tight">Heading / 18px semibold</p>
            <p className="text-sm font-medium">Subtitle / 14px medium</p>
            <p className="text-sm">Body / 14px regular — the default reading size.</p>
            <p className="text-[13px]">Dense UI / 13px — nav and compact lists.</p>
            <p className="text-xs text-muted-foreground">Meta / 12px muted.</p>
            <p className="font-mono text-xs">Mono / request ids, code, fingerprints</p>
          </div>
        </Section>

        <Section title="Button" hint="Four variants × full state coverage. Keyboard focus uses the shared ring.">
          <Row label="default">
            <Button>Primary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="ghost">Ghost</Button>
          </Row>
          <Row label="disabled">
            <Button disabled>Primary</Button>
            <Button variant="outline" disabled>
              Outline
            </Button>
          </Row>
        </Section>

        <Section title="Badges" hint="Tinted fill + inset ring + status dot; severity set is semantic, never decorative.">
          <Row label="status">
            <StatusBadge ok label="ready" />
            <StatusBadge ok={false} label="UNAVAILABLE" />
            <Badge dot>plain</Badge>
          </Row>
          <Row label="severity">
            {SEVERITIES.map((s) => (
              <SeverityBadge key={s} severity={s} />
            ))}
          </Row>
        </Section>

        <Section title="Card">
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>Card title</CardTitle>
              <Badge dot>meta</Badge>
            </CardHeader>
            <p className="text-sm leading-relaxed text-muted-foreground">Card body text at relaxed line height.</p>
          </Card>
        </Section>

        <Section title="Input" hint="Hover, focus and invalid (aria-invalid) states.">
          <div className="max-w-sm space-y-3">
            <Input placeholder="Placeholder" />
            <Input placeholder="Invalid value" aria-invalid />
          </div>
        </Section>

        <Section title="Table" hint="Sticky-ready header, row hover, tabular numerals.">
          <Table>
            <thead>
              <tr>
                <Th>Finding</Th>
                <Th className="w-32">Severity</Th>
                <Th className="w-24 text-right">Count</Th>
              </tr>
            </thead>
            <tbody>
              {SEVERITIES.map((s, i) => (
                <Tr key={s}>
                  <Td>Example finding row</Td>
                  <Td>
                    <SeverityBadge severity={s} />
                  </Td>
                  <Td className="text-right">{(i + 1) * 137}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Section>

        <Section title="Loading, empty & error states">
          <div className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <EmptyState title="Nothing here yet" description="Description slot for guidance." />
            <ErrorState code="NOT_FOUND" message="example 123 not found" requestId="req-123" />
          </div>
        </Section>
      </main>
    </>
  );
}
