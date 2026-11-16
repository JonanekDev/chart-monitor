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

export const imageFindingSchema = z.object({
  applicationName: z.string(),
  image: z.string(),
  currentTag: z.string(),
  latestTag: z.string().nullable(),
  status: versionStatusSchema,
  note: z.string().nullable(),
  /** False while the vulnerability scan of this image is still pending */
  vulnerabilitiesScanned: z.boolean(),
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
  chartFindings: z.array(chartFindingSchema),
  imageFindings: z.array(imageFindingSchema),
  cveFindings: z.array(cveFindingSchema),
});

export type ScanDetail = z.infer<typeof scanDetailSchema>;
