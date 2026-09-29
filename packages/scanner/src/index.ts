export * from './types.js';
export * from './normalize.js';
export * from './manifest.js';
export * from './registry.js';
export * from './run.js';
export * from './ingest.js';
export { refreshTrivyDb, type RefreshOptions, type RefreshResult } from './trivy-db.js';

// Adapters (exposed for unit testing + reuse).
export { normalizeSemgrep } from './adapters/semgrep.js';
export { normalizeGitleaks } from './adapters/gitleaks.js';
export { normalizeTrivy } from './adapters/trivy.js';
export { normalizePackageAudit } from './adapters/packageAudit.js';
export { normalizeComposerAudit } from './adapters/composerAudit.js';
export { normalizePhpcs } from './adapters/phpcs.js';
export { normalizeTestssl } from './adapters/testssl.js';
export { normalizeLynis, parseLynisReport } from './adapters/lynis.js';
export { normalizeZap } from './adapters/zap.js';
export { normalizeClamav, parseClamscanOutput } from './adapters/clamav.js';

// Cross-stack rule detector (S6-D3).
export { detectCrossStack } from './detectors/crossstack.js';

// WP vulnerability/advisory correlation engine (S10-D3).
export { detectWpVulnIntelligence, getAdvisories, INVENTORY_FILENAME } from './detectors/wpVulnIntel.js';
export { correlateInventory } from './intel/correlate.js';
export { WP_ADVISORIES } from './intel/wpAdvisories.fixture.js';
export type { WpInventory, WpAdvisory, WpInstalledComponent, WpComponentType, WpVulnFindingMeta, UpdateRisk } from './intel/types.js';
