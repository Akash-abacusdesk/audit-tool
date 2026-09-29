import type { FindingStatus, Severity } from '@platform/shared';

// Local copies of two tiny enums: importing the values from @platform/shared would drag the whole package
// (zod, server contracts) into the client bundle. `satisfies` makes a value that isn't a real member a compile error.
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const satisfies readonly Severity[];
export const FINDING_STATUSES = ['open', 'in_progress', 'resolved', 'false_positive', 'dismissed'] as const satisfies readonly FindingStatus[];
