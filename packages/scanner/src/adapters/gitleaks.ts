import type { FindingInput } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint } from '../normalize.js';

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Line?: string;
  Secret?: string;
  Match?: string;
  Message?: string;
  Fingerprint?: string;
  Tags?: string[];
}

export const normalizeGitleaks = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { results?: GitleaksFinding[] } | GitleaksFinding[];
  const list = Array.isArray(doc) ? doc : (doc.results ?? []);
  return list.map((f) => {
    const ruleId = f.RuleID;
    const location = { path: f.File, start_line: f.StartLine, end_line: f.EndLine };
    // §2: evidence must show the match id, never the raw secret.
    const evidence = f.Match ? `Match: ${f.Match}` : undefined;
    return {
      finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, location),
      rule_id: ruleId,
      title: ruleId ?? 'gitleaks-secret',
      description: f.Description ?? f.Message,
      severity: 'high', // §3: all confirmed matches high
      native_severity: 'high',
      confidence: 'firm',
      location,
      evidence,
      metadata: { tags: f.Tags ?? [], gitleaksFingerprint: f.Fingerprint },
    } satisfies FindingInput;
  });
};

export const gitleaks: Adapter = normalizeGitleaks;
