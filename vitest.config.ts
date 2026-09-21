import { defineConfig } from 'vitest/config';

// Unit + integration tiers run via `npm test`. tests/smoke is excluded here — it
// needs the full stack and is driven by `npm run test:smoke` (scripts/smoke.mjs).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    passWithNoTests: true,
    // integration files share one PG database and each truncates api_* tables
    // in beforeAll — cross-file parallelism would race the fixture reset.
    fileParallelism: false,
  },
});
