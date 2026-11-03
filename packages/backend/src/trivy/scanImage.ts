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
export async function scanImageForVulnerabilities(image: string): Promise<ImageVulnerability[]> {
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
    throw new TrivyScanError(`Trivy scan failed for image "${image}"`, cause);
  }
}
