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

/** Session expired or never existed: go to the login page and come back here afterwards */
function redirectToLogin(): never {
  const back = window.location.pathname + window.location.search;
  window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
  throw new ApiError('Not logged in');
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  // Same origin: the backend serves this UI (`pnpm dev` proxies /api to it, see vite.config.ts)
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (response.status === 401) redirectToLogin();
  if (!response.ok) {
    throw new ApiError(`Request to ${path} failed with status ${response.status}`);
  }
  return schema.parse(await response.json());
}

const sessionSchema = z.object({ authEnabled: z.boolean(), authenticated: z.boolean() });
export type Session = z.infer<typeof sessionSchema>;

export function getSession(): Promise<Session> {
  return request('/api/session', sessionSchema);
}

/** Resolves to false for a wrong password; throws when rate-limited or on other errors */
export async function login(password: string): Promise<boolean> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (response.status === 401) return false;
  if (response.status === 429) throw new ApiError('Too many attempts, wait a minute and try again.');
  if (!response.ok) throw new ApiError(`Login failed with status ${response.status}`);
  return true;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
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
