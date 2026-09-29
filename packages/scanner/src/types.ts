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
      cmd: (outFile: string, workspaceDir?: string, targetUrl?: string) => string[];
      extraScratch?: Array<{ path: string; sizeMb: number }>;
      /**
       * Reuse a host directory (named by env var `hostEnv`) at `container` across runs instead of a fresh tmpfs, e.g. so
       * trivy downloads its ~120MB vulnerability DB once, not on every scan. When the env var is unset the tmpfs above is used.
       * The directory must be writable by the image user.
       */
      persistentCache?: { hostEnv: string; container: string };
      readFrom?: 'file' | 'stdout';
      /** 'text' skips JSON.parse and hands the adapter the raw string (tools with no JSON output, e.g. Lynis). Default 'json'. */
      format?: 'json' | 'text';
    }
  | {
      kind: 'command';
      bin: string;
      args: (workspaceDir: string) => string[];
      readFrom: 'stdout';
      format?: 'json' | 'text';
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
  /** host dir mounted read-only at /workspace inside the worker. Omit for URL-target tools (testssl, zap) that scan a network endpoint, not a filesystem. */
  workspaceDir?: string;
  /** network endpoint for URL-target tools (testssl, zap). Ignored by filesystem-target tools. */
  targetUrl?: string;
  target: { kind: TargetKind; ref: string; branch?: string | null };
  /** override for the worker /out scratch dir (otherwise a tmpdir is made + cleaned). */
  outDir?: string;
  jobId?: string;
}

export type { FindingInput, ScanEnvelope, Severity, TargetKind };
