import { defineConfig } from 'vitest/config';

// Unit tests are pure and run in parallel; integration files share one PG database and
// each truncates api_* tables in beforeAll, so that project stays serial.
// tests/smoke is excluded — it needs the full stack (`npm run test:smoke`).
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
