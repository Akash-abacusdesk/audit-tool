import type { Severity } from '@platform/shared';
import type { Tone } from '../components/ui';

/** Severity to badge tone. (Kept out of the page files: Next only allows page exports from `page.tsx`.) */
export const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' };
