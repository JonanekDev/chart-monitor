import {
  createScanRequestSchema,
  scanDetailSchema,
  scanSummarySchema,
  type CreateScanRequest,
  type ScanDetail,
  type ScanSummary,
} from '@chart-monitor/shared';
import { z } from 'zod';

export class ApiError extends Error {}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  // Same origin: the backend serves this UI (`pnpm dev` proxies /api to it, see vite.config.ts)
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    throw new ApiError(`Request to ${path} failed with status ${response.status}`);
  }
  return schema.parse(await response.json());
}

export function createScan(input: CreateScanRequest): Promise<ScanSummary> {
  const body = createScanRequestSchema.parse(input);
  return request('/api/scans', scanSummarySchema, { method: 'POST', body: JSON.stringify(body) });
}

export function listScans(): Promise<ScanSummary[]> {
  return request('/api/scans', z.array(scanSummarySchema));
}

export function getScan(id: string): Promise<ScanDetail> {
  return request(`/api/scans/${id}`, scanDetailSchema);
}
