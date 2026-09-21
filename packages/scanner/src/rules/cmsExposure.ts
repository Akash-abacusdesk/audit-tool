import type { Severity } from '@platform/shared';

export interface CmsExposureRule {
  rule_id: string;
  title: string;
  cms: 'wordpress' | 'payload' | 'directus' | 'strapi' | 'any';
  transport: 'graphql' | 'rest' | 'any';
  severity: Severity;
  remediation: string;
}

/** S6-D4 canonical CMS exposure metadata, consumed by S6-D3 generic scanning. */
export const CMS_EXPOSURE_RULES: CmsExposureRule[] = [
  {
    rule_id: 'wp_headless_admin_token_exposure',
    title: 'WordPress headless admin token exposed client-side',
    cms: 'wordpress',
    transport: 'graphql',
    severity: 'high',
    remediation:
      'Do not ship the WP admin token / application password via NEXT_PUBLIC_*. Read it only in server components / route handlers and proxy CMS calls through a server-side integration.',
  },
  {
    rule_id: 'payload_api_key_exposure',
    title: 'Payload CMS API key exposed client-side',
    cms: 'payload',
    transport: 'rest',
    severity: 'high',
    remediation:
      'Remove PAYLOAD_* credentials from NEXT_PUBLIC_*. Use server-side env and a backend proxy; expose only a scoped public token if the client needs read access.',
  },
  {
    rule_id: 'directus_admin_token_exposure',
    title: 'Directus admin token exposed client-side',
    cms: 'directus',
    transport: 'rest',
    severity: 'high',
    remediation:
      'Never ship DIRECTUS_ADMIN_TOKEN to the client. Keep it server-only and proxy Directus requests from a route handler.',
  },
  {
    rule_id: 'strapi_api_token_exposure',
    title: 'Strapi API token exposed client-side',
    cms: 'strapi',
    transport: 'rest',
    severity: 'high',
    remediation:
      'Keep STRAPI_API_TOKEN server-only. Expose a scoped public token to the client instead of the admin API token.',
  },
  {
    rule_id: 'cms_server_only_secret_exposure',
    title: 'Server-only CMS secret referenced client-side',
    cms: 'any',
    transport: 'any',
    severity: 'high',
    remediation:
      'Reference server-only secrets exclusively in server context (route handlers, server components, getServerSideProps) and add `import "server-only"`. Never read them in client components.',
  },
];

export const CMS_EXPOSURE_RULE_IDS = CMS_EXPOSURE_RULES.map((r) => r.rule_id);

export function clientExposedEnv(name: string): boolean {
  return /^NEXT_PUBLIC_(WP|PAYLOAD|DIRECTUS|STRAPI)_(ADMIN_TOKEN|APP_PASSWORD|ADMIN|API_KEY|API_TOKEN|TOKEN|SECRET|KEY)$/i.test(
    name,
  );
}
