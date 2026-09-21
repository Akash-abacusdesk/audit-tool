# @platform/stack-detect

Filesystem/manifest stack detection for scanned repositories. Pure TypeScript,
zero runtime dependencies (node builtins only) — no DB, no API routes, no docker.

## Usage

```ts
import { detectStacks } from '@platform/stack-detect';

const result = await detectStacks('/path/to/repo-root');
// { stacks: ['nextjs','payload'], headless: true, evidence: { nextjs: [...], payload: [...] } }
```

## Output contract (STABLE — dwight's policy mapper builds against this)

```ts
interface StackDetectResult {
  stacks: ('nextjs' | 'wordpress' | 'payload' | 'directus' | 'strapi')[];
  headless: boolean;
  evidence: Partial<Record<StackId, string[]>>;
}
```

Multiple labels allowed. `headless=true` when a CMS coexists with a frontend
framework (e.g. Next.js + Payload/WP-as-backend).

## Detection markers

| Stack     | Signals                                                                 |
| --------- | ----------------------------------------------------------------------- |
| nextjs    | `package.json` dep `next`                                               |
| wordpress | `wp-config.php`, `wp-content/`                                          |
| payload   | `package.json` dep `payload`, `payload.config.ts`                       |
| directus  | `package.json` dep `directus`, `.env` with `DIRECTUS_*` var             |
| strapi    | any `*strapi*` dep, `config/plugins.(ts\|js)`, `api/` directory         |

Canonical fixtures for the validation suite live in
`tests/fixtures/repos/<stack>*` — extend those, don't fork new trees.
