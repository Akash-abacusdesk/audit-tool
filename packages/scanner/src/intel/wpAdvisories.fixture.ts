import type { WpAdvisory } from './types.js';

/**
 * Curated WP vulnerability advisory fixture for local correlation (S10-D3).
 *
 * Entries mirror the WPScan / WPVulnDB shape: a component slug, type, severity,
 * CVE/advisory identifiers, and vulnerable version ranges. The live WPScan API
 * (when `WPSCAN_API_TOKEN` is configured) supersedes this dataset; it exists so
 * correlation can be validated in CI / sandbox without network or keys. CVEs
 * marked with a real identifier are accurate; WPVULNDB-* ids are illustrative of
 * the API record shape for entries without a confirmed CVE.
 */
export const WP_ADVISORIES: WpAdvisory[] = [
  {
    slug: 'core',
    type: 'core',
    title: 'WordPress core stored XSS in Gutenberg block comments',
    description:
      'Authenticated stored cross-site scripting via the Gutenberg block editor comment handling, fixed in the 6.3.2 maintenance release.',
    severity: 'medium',
    cve_ids: ['CVE-2023-5561'],
    advisory_ids: ['WPVULNDB-WPCORE-2023-5561'],
    references: ['https://wordpress.org/news/2023/10/wordpress-6-3-2-maintenance-release/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '6.3.2' }],
    fixed_in: '6.3.2',
    update_risk: { risk: 'medium', note: 'Maintenance release — routine patch, low regression risk.' },
  },
  {
    slug: 'elementor',
    type: 'plugin',
    title: 'Elementor unauthenticated privilege escalation / auth bypass',
    description:
      'Improper access control in the user-registration / login flow allows unauthenticated attackers to elevate privileges.',
    severity: 'high',
    cve_ids: ['CVE-2023-32243'],
    advisory_ids: ['WPVULNDB-2023-32243'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2023-32243'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '3.6.5' }],
    fixed_in: '3.6.5',
    update_risk: { risk: 'high', note: 'Actively exploited in the wild — patch immediately.' },
  },
  {
    slug: 'wpdiscuz',
    type: 'plugin',
    title: 'wpDiscuz unauthenticated remote code execution via comment upload',
    description:
      'Improper file-type validation on comment attachments allows unauthenticated attackers to upload and execute arbitrary PHP.',
    severity: 'critical',
    cve_ids: ['CVE-2020-24186'],
    advisory_ids: ['WPVULNDB-2020-24186'],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2020-24186'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '7.6.4' }],
    fixed_in: '7.6.4',
    update_risk: { risk: 'high', note: 'Remote code execution — highest priority.' },
  },
  {
    slug: 'really-simple-ssl',
    type: 'plugin',
    title: 'Really Simple SSL auth bypass via REST API',
    description:
      'Missing capability checks on a REST endpoint allow unauthenticated attackers to bypass security hardening.',
    severity: 'high',
    advisory_ids: ['WPVULNDB-2023-rsssl'],
    references: ['https://wordpress.org/plugins/really-simple-ssl/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '6.0.3' }],
    fixed_in: '6.0.3',
    update_risk: { risk: 'high', note: 'Security-control bypass — patch promptly.' },
  },
  {
    slug: 'all-in-one-seo-pack',
    type: 'plugin',
    title: 'All in One SEO unauthenticated stored XSS',
    description:
      'Authenticated stored cross-site scripting in the SEO metabox affects sites below the patched version.',
    severity: 'medium',
    advisory_ids: ['WPVULNDB-2023-aioseo'],
    references: ['https://wordpress.org/plugins/all-in-one-seo-pack/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '4.2.0' }],
    fixed_in: '4.2.0',
    update_risk: { risk: 'medium' },
  },
  {
    slug: 'woocommerce',
    type: 'plugin',
    title: 'WooCommerce stored XSS in order attribution',
    description:
      'Reflected/stored XSS in the order-attribution handling allows script execution in an admin context.',
    severity: 'medium',
    advisory_ids: ['WPVULNDB-2023-woo'],
    references: ['https://wordpress.org/plugins/woocommerce/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '7.1.1' }],
    fixed_in: '7.1.1',
    update_risk: { risk: 'low' },
  },
  {
    slug: 'avada',
    type: 'theme',
    title: 'Avada theme unauthenticated file inclusion',
    description:
      'Improper sanitization of a theme option allows local file inclusion on vulnerable theme versions.',
    severity: 'high',
    advisory_ids: ['WPVULNDB-2023-avada'],
    references: ['https://themeforest.net/item/avada/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '7.11.0' }],
    fixed_in: '7.11.0',
    update_risk: { risk: 'high' },
  },
  {
    slug: 'bridge',
    type: 'theme',
    title: 'Bridge theme stored XSS in portfolio shortcode',
    description:
      'Authenticated stored cross-site scripting via the portfolio shortcode on vulnerable theme versions.',
    severity: 'medium',
    advisory_ids: ['WPVULNDB-2023-bridge'],
    references: ['https://themeforest.net/item/bridge/'],
    vulnerable_ranges: [{ introduced: undefined, fixed: '29.0' }],
    fixed_in: '29.0',
    update_risk: { risk: 'low' },
  },
];
