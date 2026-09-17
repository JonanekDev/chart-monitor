import {
  createScanRequestSchema,
  scanDetailSchema,
  scanSummarySchema,
  type CreateScanRequest,
  type ScanDetail,
  type ScanSummary,
} from '@chart-monitor/shared';
import { z } from 'zod';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
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
