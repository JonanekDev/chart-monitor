import { CveSeverity, type CveSeverityValue } from './schemas/common.js';

/** Most severe first */
export const SEVERITIES: CveSeverityValue[] = Object.values(CveSeverity).reverse();

export const severityRank = (severity: CveSeverityValue) =>
  Object.values(CveSeverity).indexOf(severity);

export type SeverityCounts = Partial<Record<CveSeverityValue, number>>;

/** Distinct vulnerability ids per severity, most severe first. Trivy reports a CVE once per
 * package (curl, curl-libs) and image, sometimes with a different severity per distro: each id
 * counts once, under its highest severity. */
export function countBySeverity(
  vulnerabilities: { vulnerabilityId: string; severity: CveSeverityValue }[],
): SeverityCounts {
  const worst = new Map<string, CveSeverityValue>();
  for (const { vulnerabilityId, severity } of vulnerabilities) {
    const known = worst.get(vulnerabilityId);
    if (!known || severityRank(severity) > severityRank(known))
      worst.set(vulnerabilityId, severity);
  }
  const counts: SeverityCounts = {};
  for (const severity of SEVERITIES) {
    const n = [...worst.values()].filter((s) => s === severity).length;
    if (n) counts[severity] = n;
  }
  return counts;
}
