// S6-D6 detection oracle (D6 / oscar). Single source of truth for unit test + CI battery.
// Rule ids confirmed by Dwight(S6-D3) + Kevin(S6-D4).
export const HEADLESS_COMBOS = [
  { name: 'nextjs-wordpress', cms: 'wordpress', transport: 'graphql',
    clientVar: 'NEXT_PUBLIC_WP_ADMIN_TOKEN', serverVar: 'WP_ADMIN_TOKEN',
    expected: [
      { ruleId: 'crossstack.next-public-secret', severity: 'high' },
      { ruleId: 'wp_headless_admin_token_exposure', severity: 'high' },
      { ruleId: 'crossstack.nextjs-cms-trust-boundary', severity: 'medium' },
    ] },
  { name: 'nextjs-payload', cms: 'payload', transport: 'rest',
    clientVar: 'NEXT_PUBLIC_PAYLOAD_API_KEY', serverVar: 'PAYLOAD_SECRET',
    expected: [
      { ruleId: 'crossstack.next-public-secret', severity: 'high' },
      { ruleId: 'payload_api_key_exposure', severity: 'high' },
      { ruleId: 'crossstack.nextjs-cms-trust-boundary', severity: 'medium' },
    ] },
  { name: 'nextjs-directus', cms: 'directus', transport: 'rest',
    clientVar: 'NEXT_PUBLIC_DIRECTUS_ADMIN_TOKEN', serverVar: 'DIRECTUS_ADMIN_TOKEN',
    expected: [
      { ruleId: 'crossstack.next-public-secret', severity: 'high' },
      { ruleId: 'directus_admin_token_exposure', severity: 'high' },
      { ruleId: 'crossstack.nextjs-cms-trust-boundary', severity: 'medium' },
    ] },
  { name: 'nextjs-strapi', cms: 'strapi', transport: 'rest',
    clientVar: 'NEXT_PUBLIC_STRAPI_API_TOKEN', serverVar: 'STRAPI_API_TOKEN',
    expected: [
      { ruleId: 'crossstack.next-public-secret', severity: 'high' },
      { ruleId: 'strapi_api_token_exposure', severity: 'high' },
      { ruleId: 'crossstack.nextjs-cms-trust-boundary', severity: 'medium' },
    ] },
];
