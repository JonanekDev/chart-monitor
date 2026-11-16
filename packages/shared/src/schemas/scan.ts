import { z } from 'zod';
import { cveSeveritySchema, scanStateSchema, versionStatusSchema } from './common.js';

export const createScanRequestSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .regex(
      /^(https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/,
      'Enter a git URL: https://host/org/repo or git@host:org/repo.git',
    ),
  searchPath: z.string().optional(),
  ref: z.string().optional(),
});

export type CreateScanRequest = z.infer<typeof createScanRequestSchema>;

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

export const scanSummarySchema = z.object({
  id: z.uuid(),
  repoUrl: z.string(),
  state: scanStateSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
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
