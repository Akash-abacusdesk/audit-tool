import type { FindingInput, Severity } from '@platform/shared';
import type { Adapter, AdapterContext } from '../types.js';
import { makeFingerprint, redactSecrets } from '../normalize.js';

// ZAP baseline/full-scan JSON report `riskcode`: 0 Informational .. 3 High.
const RISK_CODE: Record<string, Severity> = { '0': 'info', '1': 'low', '2': 'medium', '3': 'high' };

interface ZapInstance {
  uri?: string;
  method?: string;
  param?: string;
  evidence?: string;
}

interface ZapAlert {
  pluginid?: string;
  alertRef?: string;
  name?: string;
  riskcode?: string;
  desc?: string;
  solution?: string;
  cweid?: string;
  instances?: ZapInstance[];
}

interface ZapSite {
  '@name'?: string;
  alerts?: ZapAlert[];
}

/**
 * ZAP baseline/full-scan `-J` report: one entry per alert TYPE, each with an
 * `instances[]` of every URL/param it fired on. Emits one finding per
 * instance so location/evidence stay specific — an XSS on two endpoints is
 * two findings, not one.
 */
export const normalizeZap = (raw: unknown, ctx: AdapterContext): FindingInput[] => {
  const doc = raw as { site?: ZapSite[] };
  const out: FindingInput[] = [];
  for (const site of doc.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const ruleId = alert.alertRef ?? alert.pluginid;
      const severity = RISK_CODE[alert.riskcode ?? ''] ?? 'info';
      const instances = alert.instances?.length ? alert.instances : [{}];
      for (const inst of instances) {
        const location = { url_param: inst.uri };
        out.push({
          finding_fingerprint: makeFingerprint(ctx.tool, ruleId, ctx.target.ref, { path: inst.uri }),
          rule_id: ruleId,
          title: alert.name ?? 'zap-finding',
          description: alert.desc,
          severity,
          native_severity: alert.riskcode,
          confidence: 'firm',
          location,
          evidence: redactSecrets(inst.evidence),
          remediation: alert.solution ? { summary: alert.solution } : undefined,
          metadata: { method: inst.method, param: inst.param, cweId: alert.cweid, site: site['@name'] },
        } satisfies FindingInput);
      }
    }
  }
  return out;
};

export const zap: Adapter = normalizeZap;
