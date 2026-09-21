/**
 * S10-D4: WordPress core/plugin/theme inventory — canonical DTO + parser.
 *
 * The WP MU-plugin (mu-plugins/s8-monitor.php, `s8/v1/inventory` — signed with
 * the S8 event secret, reusing s8_verify_event) emits the raw inventory JSON.
 * This module is the central-side consumer: it validates/normalizes that JSON
 * into the structured `WordPressInventory` DTO that Dwight's S10-D3 CVE/
 * advisory correlation consumes, and builds the signed request the central
 * plane uses to pull inventory from a site.
 *
 * DTO agreed with Dwight (S10-D3) — see hive outbox s10-d4-dto-proposal.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';

/** One installed component (core is reported once via `core`, not here). */
export const wordPressComponentSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  version: z.string(),
  active: z.boolean(),
});
export type WordPressComponent = z.infer<typeof wordPressComponentSchema>;

export const wordPressInventorySchema = z.object({
  schema_version: z.literal('wp-inventory/1.0'),
  site_id: z.string().min(1),
  collected_at: z.string().datetime({ offset: true }),
  core: z.object({ version: z.string() }),
  plugins: z.array(wordPressComponentSchema).default([]),
  themes: z.array(wordPressComponentSchema).default([]),
});
export type WordPressInventory = z.infer<typeof wordPressInventorySchema>;

/** Fail-closed: throws on malformed input. */
export function parseWordPressInventory(raw: unknown): WordPressInventory {
  return wordPressInventorySchema.parse(raw);
}

export type InventoryComponentKind = 'core' | 'plugin' | 'theme';

/** Flat list of every version-bearing component, for correlation matching. */
export function inventoryComponents(inv: WordPressInventory): Array<
  WordPressComponent & { kind: InventoryComponentKind }
> {
  const core: WordPressComponent & { kind: InventoryComponentKind } = {
    kind: 'core',
    name: 'wordpress-core',
    slug: 'wordpress-core',
    version: inv.core.version,
    active: true,
  };
  const plugins = inv.plugins.map((p) => ({ ...p, kind: 'plugin' as const }));
  const themes = inv.themes.map((t) => ({ ...t, kind: 'theme' as const }));
  return [core, ...plugins, ...themes];
}

/**
 * Central-side: build a signed POST body for `s8/v1/inventory` (mirrors the
 * PHP `s8_verify_event` HMAC-SHA256 scheme). Returns the raw body + the
 * `X-WP-Signature` header value (`sha256=<hex>`).
 */
export function buildInventoryRequest(
  secret: string,
  payload: { request_id?: string } = {},
): { body: string; signatureHeader: string } {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return { body, signatureHeader: `sha256=${sig}` };
}
