import { readFile, readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import type { FindingInput, Severity } from '@platform/shared';
import type { AdapterContext } from '../types.js';
import { makeFingerprint, redactSecrets } from '../normalize.js';
import { CMS_EXPOSURE_RULES, clientExposedEnv } from '../rules/cmsExposure.js';

/**
 * S6-D3 cross-stack detection rules. Generic, repo-side detectors (not a third
 * party binary) that flag trust-boundary + secret-exposure anti-patterns in a
 * Next.js + CMS codebase. Each emits `findingInput[]` under the shared scanner
 * conventions: dedup key = sha256(crossstack | rule_id | target.ref | path |
 * line), severity from SEVERITIES, evidence redacted.
 *
 * Scope guard: these five rule families only. Section-7 concerns are out of
 * scope and intentionally not detected here.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', 'coverage']);

// Known-secret prefixes + generic long-token heuristic.
const SECRET_LITERAL =
  /(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_\-]{35}|glpat-[A-Za-z0-9_\-]{20,})(?![A-Za-z0-9])/gi;

const SECRET_NAME = /(SECRET|TOKEN|API_?KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)/i;
const SECRET_VALUE = /^(?:[A-Za-z0-9_\-]{24,}|[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,})$/;
const CMS_NAMES = CMS_EXPOSURE_RULES.filter((r) => r.cms !== 'any').map((r) => r.cms);
const CMS_MARK = new RegExp(`wp-json|wp_|${CMS_NAMES.join('|')}`, 'i');
const GRAPHQL_MARK = /(\/graphql|graphql\b|query\s|mutation\s)/i;
const SECRET_FIELD = /(password|token|secret|apikey|api_key|privatekey|private_key)/i;

interface Hit {
  ruleId: string;
  title: string;
  description: string;
  severity: Severity;
  line: number;
  evidence: string;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function isClientComponent(content: string): boolean {
  const first = content.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first === "'use client';" || first === '"use client";' || first === "'use client'" || first === '"use client"';
}

function mk(ruleId: string, title: string, description: string, severity: Severity, line: number, evidence: string): Hit {
  return { ruleId, title, description, severity, line, evidence };
}

function ruleNextPublic(line: string, lineNo: number): Hit[] {
  const out: Hit[] = [];
  const re = /NEXT_PUBLIC_[A-Za-z0-9_]*\s*[=:]\s*['"]?([^'"\n]*?)['"]?\s*$/gm;
  const ref = /process\.env\.(NEXT_PUBLIC_[A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = ref.exec(line))) {
    const name = m[1] ?? 'NEXT_PUBLIC';
    if (SECRET_NAME.test(name) || clientExposedEnv(name)) {
      out.push(
        mk(
          'crossstack.next-public-secret',
          `${name} is client-exposed and secret-shaped`,
          'NEXT_PUBLIC_* variables are inlined into the client bundle. A secret-shaped value here leaks to every browser.',
          'high',
          lineNo,
          `process.env.${name}`,
        ),
      );
    }
  }
  while ((m = re.exec(line))) {
    const name = m[0].match(/NEXT_PUBLIC_[A-Za-z0-9_]*/)?.[0] ?? 'NEXT_PUBLIC';
    const val = (m[1] ?? '').trim();
    if (SECRET_NAME.test(name) || clientExposedEnv(name) || SECRET_NAME.test(val) || SECRET_VALUE.test(val)) {
      out.push(
        mk(
          'crossstack.next-public-secret',
          `${name} is client-exposed and secret-shaped`,
          'NEXT_PUBLIC_* variables are inlined into the client bundle. A secret-shaped value here leaks to every browser.',
          'high',
          lineNo,
          `${name} = ${redactSecrets(val) ?? '<empty>'}`,
        ),
      );
    }
  }
  return out;
}

function ruleAdminToken(line: string, lineNo: number): Hit[] {
  const out: Hit[] = [];
  const re = /(admin_token|service_token|adminToken|serviceToken|API_KEY|APIKEY|SECRET_KEY|secretKey|ACCESS_KEY)\s*=\s*['"]([^'"]{6,})['"]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const val = m[2] ?? '';
    if (val && !val.includes('${') && (SECRET_VALUE.test(val) || SECRET_NAME.test(val))) {
      out.push(
        mk(
          'crossstack.admin-token-exposure',
          `${m[1]} hardcoded in source`,
          'Admin/service tokens must come from secret storage, not literals in the repo.',
          'high',
          lineNo,
          redactSecrets(val) ?? '',
        ),
      );
    }
  }
  return out;
}

function ruleBearer(line: string, lineNo: number): Hit[] {
  const re = /Authorization\s*:\s*['"]Bearer\s+([A-Za-z0-9_\-\.]{12,})['"]/g;
  const m = re.exec(line);
  if (m && !(m[1] ?? '').includes('${')) {
    return [
      mk(
        'crossstack.rest-graphql-secret-exposure',
        'Hardcoded bearer token in transport header',
        'REST/GraphQL calls must use a runtime-injected credential, not a literal token.',
        'high',
        lineNo,
        `Authorization: Bearer ${redactSecrets(m[1])}`,
      ),
    ];
  }
  return [];
}

function ruleGraphqlSecrets(line: string, lineNo: number): Hit[] {
  if (GRAPHQL_MARK.test(line) && SECRET_FIELD.test(line) && /(query|mutation|selection|return|res\.json|{)/i.test(line)) {
    return [
      mk(
        'crossstack.rest-graphql-secret-exposure',
        'GraphQL operation selects/exposes a secret field',
        'GraphQL responses must not carry password/token/secret fields to clients.',
        'high',
        lineNo,
        redactSecrets(line.trim())?.slice(0, 200) ?? '',
      ),
    ];
  }
  return [];
}

function ruleCms(line: string, lineNo: number, client: boolean): Hit[] {
  if (!client || !CMS_MARK.test(line)) return [];
  SECRET_LITERAL.lastIndex = 0;
  const hasSecret = SECRET_LITERAL.test(line) || SECRET_VALUE.test(line) || SECRET_FIELD.test(line);
  const envName = line.match(/process\.env\.([A-Za-z0-9_]+)/)?.[1];
  const exposedEnv = envName ? clientExposedEnv(envName) : false;
  return [
    mk(
      'crossstack.nextjs-cms-trust-boundary',
      'CMS integration code in a client component crosses the trust boundary',
      'CMS calls (wp-json/WordPress/Strapi/etc.) in client components run in the browser; server-only credentials must never cross here.',
      exposedEnv || hasSecret ? 'high' : 'medium',
      lineNo,
      redactSecrets(line.trim())?.slice(0, 200) ?? '',
    ),
  ];
}

function ruleClientSecret(line: string, lineNo: number, client: boolean): Hit[] {
  if (!client) return [];
  SECRET_LITERAL.lastIndex = 0;
  const m = SECRET_LITERAL.exec(line);
  if (!m) return [];
  return [
    mk(
      'crossstack.client-bundle-secret',
      'Secret literal in a client component (ships in the bundle)',
      'Any literal secret in a client component is emitted to the browser via the JS bundle.',
      'high',
      lineNo,
      redactSecrets(line.trim())?.slice(0, 200) ?? '',
    ),
  ];
}

export async function detectCrossStack(workspaceDir: string, ctx: AdapterContext): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const files = await walk(workspaceDir);
  const targetRef = ctx.target.ref;

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    const rel = relative(workspaceDir, file).replace(/\\/g, '/');
    const client = isClientComponent(content);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i]!;
      const hits: Hit[] = [
        ...ruleNextPublic(line, lineNo),
        ...ruleAdminToken(line, lineNo),
        ...ruleBearer(line, lineNo),
        ...ruleGraphqlSecrets(line, lineNo),
        ...ruleCms(line, lineNo, client),
        ...ruleClientSecret(line, lineNo, client),
      ];
      for (const h of hits) {
        findings.push({
          finding_fingerprint: makeFingerprint('crossstack', h.ruleId, targetRef, { path: rel, start_line: h.line }),
          rule_id: h.ruleId,
          title: h.title,
          description: h.description,
          severity: h.severity,
          native_severity: 'custom',
          confidence: 'firm',
          location: { path: rel, start_line: h.line, end_line: h.line },
          evidence: h.evidence,
          metadata: { file, rule: h.ruleId, clientComponent: client },
        } satisfies FindingInput);
      }
    }
  }
  return findings;
}
