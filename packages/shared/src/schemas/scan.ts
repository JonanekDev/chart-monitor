import { z } from 'zod';
import {
  cveSeveritySchema,
  scanPhaseSchema,
  scanStateSchema,
  versionStatusSchema,
} from './common.js';

export const chartFindingSchema = z.object({
  applicationName: z.string(),
  applicationSetName: z.string(),
  chartName: z.string(),
  repoUrl: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  status: versionStatusSchema,
  note: z.string().nullable(),
});

export type ChartFinding = z.infer<typeof chartFindingSchema>;

export const manifestChangeSchema = z.object({
  /** e.g. `Deployment monitoring/grafana` */
  resource: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
  /** What changes, with version bumps and other noise left out (see diffManifests). `before` and
   * `after` are JSON, null when the field is missing on that side */
  fields: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
  ),
  /** Changed fields not listed: CRD schemas (only counted) and anything over the per-resource
   * limit */
  fieldsNotListed: z.number().int(),
  /** The sync fails until the resource is replaced */
  immutableFields: z.array(z.string()),
  /** RBAC fields that grant permissions and change, or that an added Role/Binding has: worth a
   * review. Missing in upgrades stored before this existed */
  rbacFields: z.array(z.string()),
});

export type ManifestChange = z.infer<typeof manifestChangeSchema>;

/** One CVE + package, as found in an application's images (once, even if several images have it) */
export const vulnerabilityChangeSchema = z.object({
  vulnerabilityId: z.string(),
  pkgName: z.string(),
  severity: cveSeveritySchema,
  image: z.string(),
  title: z.string().nullable(),
});

export type VulnerabilityChange = z.infer<typeof vulnerabilityChangeSchema>;

/** One item of a chart version's `artifacthub.io/changes` annotation */
export const changelogEntrySchema = z.object({
  /** added | changed | deprecated | removed | fixed | security */
  kind: z.string(),
  description: z.string(),
  links: z.array(z.object({ name: z.string(), url: z.string() })),
});

export type ChangelogEntry = z.infer<typeof changelogEntrySchema>;

/** Changes of every version after the current one up to the latest */
export const chartChangelogSchema = z.object({
  /** Newest first; `changes` is empty when the chart publishes none */
  versions: z.array(z.object({ version: z.string(), changes: z.array(changelogEntrySchema) })),
  /** OCI versions over the load limit (each needs its own download) */
  notLoaded: z.number().int(),
  /** GitHub releases of the chart's source repo, filtered to the latest version */
  releasesUrl: z.string().nullable(),
});

export type ChartChangelog = z.infer<typeof chartChangelogSchema>;

/** What upgrading an outdated chart to its latest version would change, with the app's values */
export const chartUpgradeSchema = z.object({
  /** Keys the app sets that the new chart's values.yaml no longer has (silently ignored) */
  removedValues: z.array(z.string()),
  manifestChanges: z.array(manifestChangeSchema),
  /** The latest version doesn't render with the app's values (e.g. a newly required value) */
  renderError: z.string().nullable(),
  /** CVEs the upgrade gets rid of / brings in, most severe first. null while the images are still
   * being scanned, or when a scan failed (a partial comparison would be misleading) */
  vulnerabilities: z
    .object({
      fixed: z.array(vulnerabilityChangeSchema),
      introduced: z.array(vulnerabilityChangeSchema),
    })
    .nullable(),
  /** null when it couldn't be read; missing in upgrades stored before changelogs existed */
  changelog: chartChangelogSchema.nullable(),
});

export type ChartUpgrade = z.infer<typeof chartUpgradeSchema>;

export const chartFindingDetailSchema = chartFindingSchema.extend({
  /** Only for outdated charts */
  upgrade: chartUpgradeSchema.nullable(),
});

export type ChartFindingDetail = z.infer<typeof chartFindingDetailSchema>;

/** Vulnerabilities of the latest tag compared to the current one */
export const latestTagCheckSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('scanned'),
    fixed: z.array(vulnerabilityChangeSchema),
    introduced: z.array(vulnerabilityChangeSchema),
  }),
  /** Not a sure upgrade candidate (another variant suffix or a pre-release), so not scanned */
  z.object({ result: z.literal('variant_unclear') }),
  z.object({ result: z.literal('scan_failed') }),
]);

export type LatestTagCheck = z.infer<typeof latestTagCheckSchema>;

export const imageFindingSchema = z.object({
  applicationName: z.string(),
  image: z.string(),
  currentTag: z.string(),
  latestTag: z.string().nullable(),
  status: versionStatusSchema,
  note: z.string().nullable(),
  /** False while the vulnerability scan of this image is still pending */
  vulnerabilitiesScanned: z.boolean(),
  /** Outdated images only: whether the tag is the chart's default or set in the app's values.
   * null when undetermined */
  tagSource: z.enum(['values', 'chart']).nullable(),
  /** Outdated images whose newer tag doesn't come with a chart upgrade; null otherwise */
  latestTagCheck: latestTagCheckSchema.nullable(),
});

export type ImageFinding = z.infer<typeof imageFindingSchema>;

export const cveFindingSchema = z.object({
  applicationName: z.string(),
  image: z.string(),
  vulnerabilityId: z.string(),
  pkgName: z.string(),
  installedVersion: z.string(),
  fixedVersion: z.string().nullable(),
  severity: cveSeveritySchema,
  title: z.string().nullable(),
});

export type CveFinding = z.infer<typeof cveFindingSchema>;

/** Headline numbers for overview tables, so they don't need the full findings */
export const scanCountsSchema = z.object({
  outdatedCharts: z.number().int(),
  critical: z.number().int(),
  high: z.number().int(),
});

export type ScanCounts = z.infer<typeof scanCountsSchema>;

export const scanSummarySchema = z.object({
  id: z.uuid(),
  monitorId: z.uuid(),
  repoUrl: z.string(),
  state: scanStateSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
  /** Current (or, for a failed scan, last) step; null once the scan succeeded */
  progress: z
    .object({
      phase: scanPhaseSchema,
      done: z.number().int(),
      /** 0 when the step has no countable items */
      total: z.number().int(),
      /** Most recently finished item, e.g. a chart or image name */
      detail: z.string().nullable(),
    })
    .nullable(),
  counts: scanCountsSchema,
});

export type ScanSummary = z.infer<typeof scanSummarySchema>;

export const scanDetailSchema = scanSummarySchema.extend({
  /** What the scan skipped or could not process (unsupported generators, missing value files…) */
  warnings: z.array(z.string()),
  chartFindings: z.array(chartFindingDetailSchema),
  imageFindings: z.array(imageFindingSchema),
  cveFindings: z.array(cveFindingSchema),
});

export type ScanDetail = z.infer<typeof scanDetailSchema>;
