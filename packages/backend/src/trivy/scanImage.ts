import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CveSeverity, type CveSeverityValue } from '@chart-monitor/shared';
import { env } from '../config/env.js';
import { TrivyScanError } from '../errors.js';

const execFileAsync = promisify(execFile);

interface TrivyVulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Title?: string;
}

interface TrivyReport {
  Results?: { Vulnerabilities?: TrivyVulnerability[] }[];
}

export interface ImageVulnerability {
  vulnerabilityId: string;
  pkgName: string;
  installedVersion: string;
  fixedVersion: string | null;
  severity: CveSeverityValue;
  title: string | null;
}

function normalizeSeverity(severity: string): CveSeverityValue {
  return (Object.values(CveSeverity) as string[]).includes(severity)
    ? (severity as CveSeverityValue)
    : CveSeverity.UNKNOWN;
}

/** Scans a container image for known vulnerabilities via a shared `trivy server` (avoids each scan
 * re-downloading the vulnerability database). */
// An image trivy can't finish in TRIVY_TIMEOUT (e.g. one with gigabytes of media files to walk)
// fails the same way every time, and a failed analysis isn't cached: without this, every scan
// would wait the full timeout for it again.
// ponytail: per-process memory, a restart tries again
const TIMED_OUT_RETRY_MS = 24 * 60 * 60 * 1000;
const timedOut = new Map<string, number>();

export async function scanImageForVulnerabilities(image: string): Promise<ImageVulnerability[]> {
  const since = timedOut.get(image);
  if (since && Date.now() - since < TIMED_OUT_RETRY_MS) {
    throw new TrivyScanError(
      `Trivy scan of "${image}" skipped: it took over ${env.TRIVY_TIMEOUT} in a scan of the last ` +
        '24 hours (a larger TRIVY_TIMEOUT lets it finish once, after that it is cached)',
    );
  }
  try {
    const { stdout } = await execFileAsync(
      'trivy',
      [
        'image',
        '--server',
        env.TRIVY_SERVER_URL,
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--quiet',
        '--timeout',
        env.TRIVY_TIMEOUT,
        image,
      ],
      { maxBuffer: 1024 * 1024 * 50 },
    );

    const report = JSON.parse(stdout) as TrivyReport;
    return (report.Results ?? []).flatMap((result) =>
      (result.Vulnerabilities ?? []).map((v) => ({
        vulnerabilityId: v.VulnerabilityID,
        pkgName: v.PkgName,
        installedVersion: v.InstalledVersion,
        fixedVersion: v.FixedVersion ?? null,
        severity: normalizeSeverity(v.Severity),
        title: v.Title ?? null,
      })),
    );
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr ?? '';
    if (stderr.includes('context deadline exceeded')) timedOut.set(image, Date.now());
    throw new TrivyScanError(`Trivy scan failed for image "${image}"`, cause);
  }
}
