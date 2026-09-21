import type { FindingInput, ScanEnvelope, Severity, TargetKind } from '@platform/shared';

/** Context handed to every adapter so it can build a stable fingerprint. */
export interface AdapterContext {
  tool: string;
  target: { kind: TargetKind; ref: string; branch?: string | null };
}

export type Adapter = (raw: unknown, ctx: AdapterContext) => FindingInput[];

/** Internal cross-stack rule detector: reads the workspace and emits findings directly. */
export type RulesDetector = (
  workspaceDir: string,
  ctx: AdapterContext,
) => FindingInput[] | Promise<FindingInput[]>;

/** How a scanner is invoked for a scan run. */
export type Invocation =
  | {
      kind: 'image';
      /** profiles.json key (resource ceiling). */
      profile: string;
      /** artifact file name written under /out (image file mode) or ignored (stdout). */
      outFile: string;
      /** default-deny floor: scanners read /out from here; egress is offline unless noted. */
      egress?: 'offline' | 'bridge';
      cmd: (outFile: string, workspaceDir?: string) => string[];
      extraScratch?: Array<{ path: string; sizeMb: number }>;
      readFrom?: 'file' | 'stdout';
    }
  | {
      kind: 'command';
      bin: string;
      args: (workspaceDir: string) => string[];
      readFrom: 'stdout';
    }
  | {
      kind: 'rules';
      detect: RulesDetector;
    };

export interface ScanRequest {
  scanId: string;
  projectId: string;
  environmentId?: string;
  /** registry key, e.g. 'semgrep' | 'gitleaks' | 'trivy' | 'npm-audit' | ... */
  tool: string;
  /** host dir mounted read-only at /workspace inside the worker. */
  workspaceDir: string;
  target: { kind: TargetKind; ref: string; branch?: string | null };
  /** override for the worker /out scratch dir (otherwise a tmpdir is made + cleaned). */
  outDir?: string;
  jobId?: string;
}

export type { FindingInput, ScanEnvelope, Severity, TargetKind };
