# Frontend Architecture & Design System — S1-D5

Owner: Angela (angela-mt3xrjjp) · Scope: Section 1 only (build plan `6_Developer_Task_Distribution_Capacity_Agnostic.md` lines 150–156)
Serves PRD §2.1(1) (`Unified_DevSecOps_Platform_PRD_v16_Capacity_Agnostic.md` lines 44–46): kanban/table views for security findings, operational tasks, update failures, remediation work — with project assignment, ownership, severity, due date, status.

Status legend: ✅ decided · ⏳ pending confirmation from D1 (Jim, conversation `S1-monorepo`) — flagged items must not block his skeleton; they adapt to it.

## 1. Stack

- **Next.js (App Router) + TypeScript strict** ✅ — PRD stack is Next.js/TypeScript; RSC-by-default keeps client bundles small.
- **Tailwind CSS v4** ✅ — utility layer + token carrier; no separate CSS-in-JS runtime.
- **shadcn/ui pattern (Radix primitives, copied-in source)** ✅ — accessible headless behavior owned by us, styled by our tokens. No UI kit lock-in.
- **TanStack Query** ✅ — all server state; no global client store (no Redux/Zustand) until a real need appears.
- **Package placement**: portal lives in the monorepo as an app (path per Jim's skeleton ⏳), shared TS types imported from the backend contracts package (`@platform/*` naming per Jim ⏳).
- **Package manager / task runner**: whatever Jim standardizes (⏳ pnpm assumed).

## 2. Application structure (inside the portal app)

```
src/
  app/
    (portal)/            # authenticated shell layout — sidebar + topbar
      layout.tsx         # app shell mount point
      page.tsx           # overview/landing (S1: placeholder proving shell renders)
      design/page.tsx    # primitive gallery = living usage examples (DoD)
    api-proxy-note.md    # why portal talks only to our API gateway
  components/
    ui/                  # design-system primitives (button, table, badge, card, dialog, …)
    shell/               # sidebar, topbar, breadcrumbs, command palette stub
  lib/                   # fetch wrapper enforcing API error conventions (Jim's envelope ⏳)
```

Rules:
- **Server Components by default**; `"use client"` only where interactivity demands (kanban drag, dialogs, filters).
- Portal never imports backend internals — only the shared types package. Contract drift breaks CI, not prod.
- All data fetching goes through `lib/` fetch wrapper → single place to enforce error envelope, retry, idempotency headers.

## 3. Navigation model (S1 = structural only)

Primary sections mirror PRD objectives (routes reserved, pages come in later sections):

| Route | Section | PRD anchor |
|---|---|---|
| `/` | Overview | §2.1 |
| `/findings` | Security findings kanban/table | §2.1(1) |
| `/tasks` | Operational/remediation tasks | §2.1(1) |
| `/projects` | Project assignment & ownership | §2.1(1) |
| `/updates` | WP update pipeline status | §2.1(4) |
| `/access` | JIT grants (Section 2+ feature) | §2.1(5) |
| `/settings` | Config | — |

S1 ships only `/` and `/design`; other routes appear as their sections land. No auth screens (Section 2).

## 4. Design system

Elevated to premium quality per the S1-D5-PREMIUM directive; standards applied from the
`impeccable` skill (product register): earned familiarity over novelty, one system font
family with a fixed rem ramp, restrained color, motion only as state feedback.

### Tokens (CSS variables, dark-mode-first via `.dark` class)

- Surface ladder (product register's second neutral layer): `background` (app canvas) →
  `surface` (sidebar/topbar panels) → `card` (raised content). Panels are no longer the
  same color as cards.
- Semantic color set: `background`, `foreground`, `surface`, `muted`, `muted-foreground`,
  `card`, `border`, `primary`, `primary-foreground`, `destructive`, `success`, `ring`.
- Severity scale is a first-class token family: `--severity-critical|high|medium|low|info`
  — values map 1:1 onto D3's normalized severity vocabulary
  (`docs/scanning/SCANNING-CONVENTIONS.md` §3). Badges render tinted fill + inset ring +
  status dot from these tokens.
- Depth: single `shadow-xs` elevation for resting cards/inputs/tables. No stacked shadows,
  no glass effects — depth is a quiet cue, not decoration.
- Focus: one systematic `:focus-visible` outline (`--ring`) defined once in `globals.css`;
  every interactive element inherits it. Never remove outlines without replacement.
- Radius: `rounded-lg` on controls/cards (8px), `rounded-xl` on raised surfaces (12px).
- Typography: system stack, fixed sizes 11/12/13/14/18px (no fluid clamps in product UI),
  tabular numerals in tables/data, `tracking-tight` on headings only.
- Density stays compact — this is a power-user operations console.

### Primitive inventory (S1 minimum)

Button (4 variants × default/hover/active/focus/disabled), Badge (+SeverityBadge,
StatusBadge, optional dot), Card, Table (Th/Td/Tr with row hover + tabular-nums), Input
(hover/focus/aria-invalid), Skeleton, EmptyState, ErrorState, PageHeader.

State coverage rule (impeccable product register): every interactive primitive ships
default/hover/focus-visible/disabled at minimum; async primitives add loading when they
exist. Zero business logic in primitives.

Deferred until their feature sections land: Dialog, DropdownMenu, Tabs, Toast,
KanbanColumn/Card shells, Select, dark-mode toggle (dark is default).

### Layout rules

- Sidebar: fixed 240px on distinct `surface`, grouped nav ("Reserved" group labels),
  active item = soft primary pill with inset ring.
- Topbar: sticky, breadcrumb left, env indicator (status dot + mono label) right;
  `backdrop-blur` only because content scrolls beneath it.
- Content max-width none (ops dashboards use full width); gallery caps at 5xl for reading
  rhythm; consistent 24px gutter.
- Motion: 150ms ease-out transitions on background-color/box-shadow/color only;
  respect `prefers-reduced-motion`; no page-load choreography (product register).

## 5. Error & loading conventions

- Every route segment gets `error.tsx` + `loading.tsx` (Skeletons, never spinners for lists).
- Errors render through a shared `<ErrorState>` consuming Jim's error envelope shape (code/message/correlationId ⏳) — correlationId shown to user for support traceability.

## 6. Boundaries (S1)

Shell + primitives + placeholder overview + gallery only. No feature pages, no auth UI, no real data wiring beyond a health-check fetch if Jim's first endpoint exists in time (it also exercises the error/success envelope end-to-end, satisfying validation line 169).

## 7. Resolutions

1. Portal app: `apps/portal` as `@platform/portal`, dev/prod on port **3001** (`npm run dev:portal`). Root workspaces extended with `apps/*`; root `tsconfig.json` references deliberately exclude the portal (Next.js typechecks itself in `next build`; `tsc -b` stays green).
2. Shared types package: `@platform/shared` (envelope `ApiResponse<T>`, `ERROR_CODES`) — imported type-only where possible.
3. Error envelope: implemented in `src/lib/api.ts` (`apiFetch<T>` → data or `ApiRequestError{code,message,requestId}`); health endpoints are enveloped too (`ok({status})`).
4. Severity vocabulary frozen by D3 (`docs/scanning/SCANNING-CONVENTIONS.md`): critical|high|medium|low|info → `--severity-*` tokens.

Deferred until their feature sections land (gallery grows then): Dialog, DropdownMenu, Tabs, Toast, KanbanColumn/Card shells, dark-mode toggle (dark is default), collapsible sidebar.
