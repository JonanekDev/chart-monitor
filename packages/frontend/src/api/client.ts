import {
  channelSchema,
  monitorSchema,
  scanDetailSchema,
  scanSummarySchema,
  schedulePreviewSchema,
  type Channel,
  type ChannelInput,
  type Monitor,
  type MonitorInput,
  type MonitorUpdate,
  type ScanDetail,
  type ScanSummary,
  type SchedulePreview,
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
    // Only with a body: the server rejects an empty body declared as JSON (e.g. "Run now", delete)
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (response.status === 401) redirectToLogin();
  if (!response.ok) {
    // The API explains 400/404/409 in `error`; fall back to the status for anything else
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string'
        ? body.error
        : `Request to ${path} failed with status ${response.status}`,
    );
  }
  if (response.status === 204) return schema.parse(undefined);
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
  if (response.status === 429)
    throw new ApiError('Too many attempts, wait a minute and try again.');
  if (!response.ok) throw new ApiError(`Login failed with status ${response.status}`);
  return true;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export function listMonitors(): Promise<Monitor[]> {
  return request('/api/monitors', z.array(monitorSchema));
}

export function createMonitor(input: MonitorInput): Promise<Monitor> {
  return request('/api/monitors', monitorSchema, { method: 'POST', body: JSON.stringify(input) });
}

export function updateMonitor(id: string, patch: MonitorUpdate): Promise<Monitor> {
  return request(`/api/monitors/${id}`, monitorSchema, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteMonitor(id: string): Promise<void> {
  return request(`/api/monitors/${id}`, z.undefined(), { method: 'DELETE' });
}

export function runMonitor(id: string): Promise<ScanSummary> {
  return request(`/api/monitors/${id}/scans`, scanSummarySchema, { method: 'POST' });
}

export function previewSchedule(expression: string): Promise<SchedulePreview> {
  return request(
    `/api/schedule-preview?expression=${encodeURIComponent(expression)}`,
    schedulePreviewSchema,
  );
}

export function getScan(id: string): Promise<ScanDetail> {
  return request(`/api/scans/${id}`, scanDetailSchema);
}

export function listChannels(): Promise<Channel[]> {
  return request('/api/channels', z.array(channelSchema));
}

export function createChannel(input: ChannelInput): Promise<Channel> {
  return request('/api/channels', channelSchema, { method: 'POST', body: JSON.stringify(input) });
}

export function deleteChannel(id: string): Promise<void> {
  return request(`/api/channels/${id}`, z.undefined(), { method: 'DELETE' });
}

/** Rejects with the reason (e.g. "webhook answered 404") when the message can't be delivered */
export function testChannel(id: string): Promise<void> {
  return request(`/api/channels/${id}/test`, z.undefined(), { method: 'POST' });
}
