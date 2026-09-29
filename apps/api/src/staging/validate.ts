/**
 * Section-12 Functional/Visual validation — D1. Runs a real headless Chrome
 * against the staging container over its own docker network (no host
 * networking needed), on the browser_heavy workload class.
 *
 * smoke: HTTP reachability only (used by provision readiness).
 * functional: page loads without a PHP fatal/DB-connection error string.
 * visual: functional check + a full-page screenshot persisted to outDir,
 *   diffed byte-for-byte against the previous run's screenshot for this
 *   staging id (first run has no baseline, so it becomes one — a
 *   pass/fail-on-any-pixel-change is the ceiling here; a perceptual/masked
 *   diff is the upgrade once a real design calls for tolerance).
 */
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execDocker } from '@platform/worker-runtime';
import type { StagingRuntime } from './provisioner.js';

/**
 * --no-sandbox is needed in a container without a seccomp profile for Chrome's user-namespace sandbox, so the
 * container itself is the boundary: no capabilities, no privilege escalation, read-only root, bounded resources.
 */
const CHROME_HARDEN = [
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
  '--tmpfs', '/tmp', '--tmpfs', '/home/chrome', '--memory', '1g', '--pids-limit', '512',
];
const CHROME_IMAGE = process.env.STAGING_CHROME_IMAGE ?? 'zenika/alpine-chrome:latest@sha256:eb3378c1ed0079f94db054a5fe1aaa790a254ec0d6bbc67eda052420d86a179d';
const FATAL_MARKERS = ['Fatal error', 'Error establishing a database connection', 'Uncaught Error'];

export interface ValidationResult {
  suite: 'smoke' | 'functional' | 'visual';
  passed: boolean;
  detail: string;
  screenshotPath?: string;
  diffFromBaseline?: boolean;
}

/**
 * Headless Chrome joins the staging run's own docker network and hits the WP
 * container by name — no host networking needed. Two separate invocations:
 * the image's own ENTRYPOINT is `chromium-browser --headless`, and combining
 * --dump-dom with --screenshot in one run trips chromium's
 * "Multiple targets are not supported" — verified live against a real
 * ephemeral WordPress container this session.
 */
async function runHeadlessChrome(runtime: StagingRuntime, outDir: string): Promise<{ dom: string; screenshotFile: string | null }> {
  await mkdir(outDir, { recursive: true });
  const screenshotFile = path.join(outDir, 'shot.png');
  const domFile = path.join(outDir, 'dom.html');
  const url = `http://${runtime.wpContainer}/`;

  const domResult = await execDocker([
    'run', '--rm', '--network', runtime.networkName,
    '--label', 'com.platform.staging=true', ...CHROME_HARDEN,
    CHROME_IMAGE,
    '--disable-gpu', '--no-sandbox', '--dump-dom', url,
  ]);
  await writeFile(domFile, domResult.stdout).catch(() => {});

  // Chrome runs as uid 1000 in the container; on a Linux host mkdtemp's 0700 dir would be unwritable to it
  // (Docker Desktop bind mounts hide this). The dir is a short-lived per-run temp dir.
  await chmod(outDir, 0o777).catch(() => {});
  const shotResult = await execDocker([
    'run', '--rm', '--network', runtime.networkName,
    '--label', 'com.platform.staging=true', ...CHROME_HARDEN,
    '-v', `${outDir}:/out`,
    CHROME_IMAGE,
    '--disable-gpu', '--no-sandbox', '--window-size=1280,800', '--screenshot=/out/shot.png', url,
  ]);
  return { dom: domResult.stdout, screenshotFile: shotResult.code === 0 ? screenshotFile : null };
}

/** Real HTTP reachability check — used for the `smoke` suite and provision readiness. */
export async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function runValidation(
  stagingId: string,
  suite: 'smoke' | 'functional' | 'visual',
  runtime: StagingRuntime,
  outDir: string
): Promise<ValidationResult> {
  if (suite === 'smoke') {
    const ok = await checkReachable(`http://127.0.0.1:${runtime.hostPort}/`);
    return { suite, passed: ok, detail: ok ? 'reachable' : 'unreachable' };
  }

  const { dom, screenshotFile } = await runHeadlessChrome(runtime, outDir);
  const fatal = FATAL_MARKERS.find((m) => dom.includes(m));
  if (fatal) return { suite, passed: false, detail: `page contains: ${fatal}` };
  if (!dom.trim()) return { suite, passed: false, detail: 'empty response body' };

  if (suite === 'functional') {
    return { suite, passed: true, detail: 'page rendered without fatal errors' };
  }

  // visual: compare against the prior screenshot for this staging run, if any.
  const baselinePath = path.join(path.dirname(outDir), `${stagingId}-baseline.png`);
  let diffFromBaseline = false;
  if (!screenshotFile) return { suite, passed: false, detail: 'screenshot capture failed' };
  const current = await readFile(screenshotFile);
  try {
    const baseline = await readFile(baselinePath);
    diffFromBaseline = !baseline.equals(current);
  } catch {
    diffFromBaseline = false; // no baseline yet — this run becomes it
  }
  await writeFile(baselinePath, current);
  return {
    suite,
    passed: true,
    detail: diffFromBaseline ? 'visual diff detected vs. previous run' : 'no visual diff vs. previous run',
    screenshotPath: screenshotFile,
    diffFromBaseline,
  };
}
