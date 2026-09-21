import { readFileSync } from 'node:fs';

export interface ToolEntry {
  name: string;
  image: string | null;
  version_tag: string;
  digest_sha256: string | null;
  packaging: { mode: string; base_tag?: string; note?: string };
}

export interface ToolsManifest {
  tools: ToolEntry[];
}

export interface ToolMeta {
  version: string;
  imageDigest: string | null;
}

function toolsPath(override?: string): string {
  return (
    override ??
    process.env.SCANNER_TOOLS_PATH ??
    new URL('../../../scanner/tools.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  );
}

function recordPath(override?: string): string {
  return (
    override ??
    process.env.SCANNER_BUILD_RECORD_PATH ??
    new URL('../../../scanner/build-record.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  );
}

export function loadTools(path?: string): ToolsManifest {
  return JSON.parse(readFileSync(toolsPath(path), 'utf8')) as ToolsManifest;
}

export function toolMeta(tool: string, path?: string): ToolMeta {
  const entry = loadTools(path).tools.find((t) => t.name === tool);
  return { version: entry?.version_tag ?? 'unknown', imageDigest: entry?.digest_sha256 ?? null };
}

/**
 * Resolve the digest-pinned worker image for a tool:
 *   1. derived build-record tag (authoritative when present)
 *   2. upstream image + version_tag fallback
 *   3. null when the image is not yet packaged (e.g. phpcs-wpcs planned-s5)
 */
export function resolveImage(tool: string, toolsPath?: string, buildRecordPath?: string): string | null {
  const entry = loadTools(toolsPath).tools.find((t) => t.name === tool);
  if (!entry) return null;
  try {
    const rec = JSON.parse(readFileSync(recordPath(buildRecordPath), 'utf8')) as {
      images?: Array<{ name?: string; tool?: string; tag?: string }>;
    };
    const img = rec.images?.find((i) => (i.tool ?? i.name) === tool);
    if (img?.tag) return img.tag;
  } catch {
    /* no build record present */
  }
  if (entry.image && entry.version_tag) return `${entry.image}:${entry.version_tag}`;
  return null;
}
