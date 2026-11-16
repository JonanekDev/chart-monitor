import { z } from 'zod';

export const VersionStatus = {
  UP_TO_DATE: 'up_to_date',
  OUTDATED: 'outdated',
  UNKNOWN: 'unknown',
} as const;

export const versionStatusSchema = z.enum([
  VersionStatus.UP_TO_DATE,
  VersionStatus.OUTDATED,
  VersionStatus.UNKNOWN,
]);

export type VersionStatusValue = z.infer<typeof versionStatusSchema>;

export const ScanState = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export const scanStateSchema = z.enum([
  ScanState.PENDING,
  ScanState.RUNNING,
  ScanState.SUCCEEDED,
  ScanState.FAILED,
]);

export type ScanStateValue = z.infer<typeof scanStateSchema>;

/** Scan steps in execution order; the UI lists them as a checklist */
export const ScanPhase = {
  CLONING: 'cloning',
  RESOLVING: 'resolving',
  CHART_VERSIONS: 'chart_versions',
  IMAGES: 'images',
  VULNERABILITIES: 'vulnerabilities',
} as const;

export const scanPhaseSchema = z.enum([
  ScanPhase.CLONING,
  ScanPhase.RESOLVING,
  ScanPhase.CHART_VERSIONS,
  ScanPhase.IMAGES,
  ScanPhase.VULNERABILITIES,
]);

export type ScanPhaseValue = z.infer<typeof scanPhaseSchema>;

export const CveSeverity = {
  UNKNOWN: 'UNKNOWN',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export const cveSeveritySchema = z.enum([
  CveSeverity.UNKNOWN,
  CveSeverity.LOW,
  CveSeverity.MEDIUM,
  CveSeverity.HIGH,
  CveSeverity.CRITICAL,
]);

export type CveSeverityValue = z.infer<typeof cveSeveritySchema>;
