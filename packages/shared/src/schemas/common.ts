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
