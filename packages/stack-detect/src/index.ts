/**
 * node builtins load LAZILY (inside functions, never at module scope) so that
 * bundling this module into a browser graph — e.g. via @platform/shared's
 * barrel re-export of STACK_IDS — never emits a `node:` reference for
 * webpack: a top-level node: import breaks `next build` (UnhandledSchemeError).
 * detectStacks only ever RUNS server-side; client imports resolve just the
 * pure vocabulary/types below.
 */
type FsPromises = typeof import('node:fs/promises');
let fspP: Promise<FsPromises> | undefined;
// ponytail: webpackIgnore stops client bundlers resolving node: at build time;
// these imports only execute inside detectStacks, which never runs in a browser.
const fsp = (): Promise<FsPromises> =>
  (fspP ??= import(/* webpackIgnore: true */ 'node:fs/promises'));

type NodePath = typeof import('node:path');
let pathP: Promise<NodePath> | undefined;
const nodePath = (): Promise<NodePath> =>
  (pathP ??= import(/* webpackIgnore: true */ 'node:path'));

/**
 * Canonical stack ids — single source of truth for the detection vocabulary
 * (mirrors tool/cms/signatures.json `stacks[].id` exactly). @platform/shared
 * re-exports this; do not re-declare the union anywhere else.
 */
export const STACK_IDS = ['nextjs', 'wordpress', 'payload', 'directus', 'strapi'] as const;

export type StackId = (typeof STACK_IDS)[number];

/**
 * Detection contract — dwight's policy mapper builds against this shape.
 * Do not change casually; coordinate via god first.
 */
export interface StackDetectResult {
  stacks: StackId[];
  /** true when a CMS coexists with a frontend framework (headless pairing). */
  headless: boolean;
  /** Per-stack evidence lines; keys present only for detected stacks. */
  evidence: Partial<Record<StackId, string[]>>;
}

const FRONTEND: StackId[] = ['nextjs'];
const HEADLESS_CMS: StackId[] = ['wordpress', 'payload', 'directus', 'strapi'];

async function exists(p: string): Promise<boolean> {
  try {
    const { access } = await fsp();
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const { stat } = await fsp();
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Merged dependencies + devDependencies of the repo-root package.json. */
async function readDeps(root: string): Promise<Record<string, string>> {
  try {
    const [{ readFile }, { join }] = await Promise.all([fsp(), nodePath()]);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

async function readDotEnv(root: string): Promise<string> {
  try {
    const [{ readFile }, { join }] = await Promise.all([fsp(), nodePath()]);
    return await readFile(join(root, '.env'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Detect stacks in a repository root via filesystem/manifest analysis.
 * Pure filesystem reads: no DB, no network, no docker.
 */
export async function detectStacks(repoRoot: string): Promise<StackDetectResult> {
  const { join } = await nodePath();
  const evidence: Partial<Record<StackId, string[]>> = {};
  const add = (stack: StackId, line: string): void => {
    (evidence[stack] ??= []).push(line);
  };

  const deps = await readDeps(repoRoot);

  if ('next' in deps) add('nextjs', 'package.json: dependency "next"');

  if (await exists(join(repoRoot, 'wp-config.php'))) add('wordpress', 'file: wp-config.php');
  if (await exists(join(repoRoot, 'wp-content'))) add('wordpress', 'dir: wp-content/');

  if ('payload' in deps) add('payload', 'package.json: dependency "payload"');
  if (await exists(join(repoRoot, 'payload.config.ts'))) add('payload', 'file: payload.config.ts');

  if ('directus' in deps) {
    add('directus', 'package.json: dependency "directus"');
  } else if (/^DIRECTUS_/m.test(await readDotEnv(repoRoot))) {
    add('directus', '.env: DIRECTUS_* variable');
  }

  if (Object.keys(deps).some((d) => d.includes('strapi'))) {
    add('strapi', 'package.json: strapi dependency');
  }
  for (const f of ['config/plugins.ts', 'config/plugins.js']) {
    if (await exists(join(repoRoot, f))) add('strapi', `file: ${f.replaceAll('\\', '/')}`);
  }
  if (await isDir(join(repoRoot, 'api'))) add('strapi', 'dir: api/');

  const stacks = Object.keys(evidence) as StackId[];
  const headless =
    stacks.some((s) => FRONTEND.includes(s)) && stacks.some((s) => HEADLESS_CMS.includes(s));

  return { stacks, headless, evidence };
}
