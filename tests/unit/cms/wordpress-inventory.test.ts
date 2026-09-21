import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildInventoryRequest,
  inventoryComponents,
  parseWordPressInventory,
  wordPressInventorySchema,
} from '../../../cms/wordpress/inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string): unknown => JSON.parse(readFileSync(join(here, '../../../cms/wordpress/tests/fixtures', n), 'utf8'));

describe('S10-D4 wordpress inventory', () => {
  it('parses a realistic site inventory', () => {
    const inv = parseWordPressInventory(fx('wordpress-inventory.sample.json'));
    expect(inv.site_id).toBe('site-prod-01');
    expect(inv.core.version).toBe('6.4.2');
    expect(inv.plugins).toHaveLength(3);
    expect(inv.themes.filter((t) => t.active)).toHaveLength(1);
  });

  it('flattens every component with its kind', () => {
    const inv = parseWordPressInventory(fx('wordpress-inventory.sample.json'));
    const comps = inventoryComponents(inv);
    expect(comps[0]).toMatchObject({ kind: 'core', slug: 'wordpress-core', active: true });
    expect(comps.filter((c) => c.kind === 'plugin')).toHaveLength(3);
    expect(comps.filter((c) => c.kind === 'theme')).toHaveLength(2);
    expect(comps.find((c) => c.slug === 'elementor')?.version).toBe('3.21.0');
  });

  it('emits the known-vulnerable fixture for S10-D6', () => {
    const inv = parseWordPressInventory(fx('wordpress-inventory.vulnerable.json'));
    const elementor = inventoryComponents(inv).find((c) => c.slug === 'elementor');
    expect(elementor?.kind).toBe('plugin');
    expect(elementor?.version).toBe('3.15.3');
  });

  it('fails closed on a bad schema_version', () => {
    const bad = { ...(fx('wordpress-inventory.sample.json') as Record<string, unknown>) };
    bad.schema_version = 'wp-inventory/9.9';
    expect(() => parseWordPressInventory(bad)).toThrow();
  });

  it('fails closed when a plugin is missing version', () => {
    const bad = JSON.parse(JSON.stringify(fx('wordpress-inventory.sample.json')));
    delete bad.plugins[0].version;
    expect(() => wordPressInventorySchema.parse(bad)).toThrow();
  });

  it('builds a verifiable signed inventory request (mirrors PHP s8_verify_event)', () => {
    const secret = 'test-secret';
    const { body, signatureHeader } = buildInventoryRequest(secret, { request_id: 'r1' });
    const sig = signatureHeader.replace(/^sha256=/, '');
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(sig).toBe(expected);
    expect(JSON.parse(body)).toEqual({ request_id: 'r1' });
  });
});
