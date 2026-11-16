import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Monitor } from '@chart-monitor/shared';
import { PrismaClient } from '../generated/prisma/client.js';
import type { ScanReporter } from '../scan/runScan.js';

// The scan itself is faked: each call waits until the test releases it, then reports findings
const releases: (() => void)[] = [];
vi.mock('../scan/runScan.js', () => ({
  executeScan: async (_input: unknown, reporter: ScanReporter) => {
    await new Promise<void>((resolve) => releases.push(resolve));
    await reporter.chartFinding({
      applicationName: 'app',
      applicationSetName: '',
      chartName: 'redis',
      repoUrl: 'https://charts.example.com',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      status: 'outdated',
      note: null,
    });
    const cve = { applicationName: 'app', image: 'redis', pkgName: 'p', installedVersion: '1' };
    await reporter.imageScanned({ repository: 'redis', tag: '7' }, [
      { ...cve, vulnerabilityId: 'CVE-1', fixedVersion: null, severity: 'CRITICAL', title: null },
      { ...cve, vulnerabilityId: 'CVE-2', fixedVersion: null, severity: 'HIGH', title: null },
      { ...cve, vulnerabilityId: 'CVE-3', fixedVersion: null, severity: 'HIGH', title: null },
      { ...cve, vulnerabilityId: 'CVE-4', fixedVersion: null, severity: 'LOW', title: null },
    ]);
  },
}));

const { monitorRoutes } = await import('../routes/monitors.js');
const { Scheduler } = await import('../monitor/scheduler.js');

const dir = mkdtempSync(path.join(tmpdir(), 'monitors-test-'));
const url = `file:${path.join(dir, 'test.db')}`;
let prisma: PrismaClient;
const scheduler = new Scheduler(async () => {});
const app = Fastify();

beforeAll(async () => {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
  });
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  await app.register(monitorRoutes({ prisma, scheduler, retention: 2 }));
}, 60_000);

afterAll(async () => {
  scheduler.stopAll();
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.monitor.deleteMany();
});

// Finish every scan a test left behind, so the next test starts with an idle queue
afterEach(async () => {
  await waitFor(async () => {
    releases.splice(0).forEach((release) => release());
    return (await prisma.scan.count({ where: { state: { in: ['pending', 'running'] } } })) === 0;
  });
});

const list = async () => (await app.inject('/api/monitors')).json<Monitor[]>();
const states = async (monitorId: string) =>
  (await prisma.scan.findMany({ where: { monitorId }, orderBy: { createdAt: 'asc' } })).map(
    (s) => s.state,
  );

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

/** Lets the oldest waiting fake scan finish */
async function releaseNext() {
  await waitFor(async () => releases.length > 0);
  releases.shift()!();
}

async function createMonitor(body: object) {
  const res = await app.inject({ method: 'POST', url: '/api/monitors', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json<Monitor>();
}

describe('monitors API', () => {
  it('validates input and the schedule', async () => {
    const bad = [
      { repoUrl: 'not a url', schedule: null },
      { repoUrl: 'https://github.com/o/r', schedule: '* * * * *' },
      { repoUrl: 'https://github.com/o/r', schedule: 'nonsense' },
    ];
    for (const payload of bad) {
      expect((await app.inject({ method: 'POST', url: '/api/monitors', payload })).statusCode).toBe(
        400,
      );
    }
    expect(await list()).toEqual([]);
  });

  it('starts the first scan on create and reports headline counts once done', async () => {
    const monitor = await createMonitor({
      repoUrl: 'git@github.com:o/r.git',
      ref: '',
      schedule: '0 3 * * *',
    });
    expect(monitor).toMatchObject({ ref: null, enabled: true });
    expect(['pending', 'running']).toContain(monitor.scans[0]!.state);
    expect(monitor.nextRunAt).not.toBeNull();

    await releaseNext();
    await waitFor(async () => (await states(monitor.id))[0] === 'succeeded');
    const [listed] = await list();
    expect(listed!.scans[0]!.counts).toEqual({ outdatedCharts: 1, critical: 1, high: 2 });
  });

  it('runs scans one at a time and refuses a second run of a busy monitor', async () => {
    const a = await createMonitor({ repoUrl: 'https://github.com/o/a', schedule: null });
    const b = await createMonitor({ repoUrl: 'https://github.com/o/b', schedule: null });
    const runA = await app.inject({ method: 'POST', url: `/api/monitors/${a.id}/scans` });
    expect(runA.statusCode).toBe(409);

    await waitFor(async () => (await states(a.id))[0] === 'running');
    expect(await states(b.id)).toEqual(['pending']); // queued behind a

    await releaseNext();
    await waitFor(async () => (await states(b.id))[0] === 'running');
    expect(await states(a.id)).toEqual(['succeeded']);
    await releaseNext();
    await waitFor(async () => (await states(b.id))[0] === 'succeeded');
  });

  it('keeps only the newest scans per monitor', async () => {
    const monitor = await createMonitor({ repoUrl: 'https://github.com/o/r', schedule: null });
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        expect(
          (await app.inject({ method: 'POST', url: `/api/monitors/${monitor.id}/scans` }))
            .statusCode,
        ).toBe(201);
      }
      await releaseNext();
      await waitFor(async () => (await states(monitor.id)).every((s) => s === 'succeeded'));
    }
    expect(await states(monitor.id)).toEqual(['succeeded', 'succeeded']);
    expect(await prisma.chartFinding.count()).toBe(2); // findings of the pruned scan are gone too
  });

  it('pauses, edits and deletes', async () => {
    const monitor = await createMonitor({
      repoUrl: 'https://github.com/o/r',
      schedule: '0 3 * * *',
    });
    await releaseNext();

    const paused = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      payload: { enabled: false },
    });
    expect(paused.json()).toMatchObject({ enabled: false, nextRunAt: null, schedule: '0 3 * * *' });
    const badEdit = await app.inject({
      method: 'PATCH',
      url: `/api/monitors/${monitor.id}`,
      payload: { schedule: 'x' },
    });
    expect(badEdit.statusCode).toBe(400);

    await waitFor(async () => (await states(monitor.id))[0] === 'succeeded');
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/monitors/${monitor.id}` })).statusCode,
    ).toBe(204);
    expect(await prisma.scan.count({ where: { monitorId: monitor.id } })).toBe(0);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/monitors/${monitor.id}` })).statusCode,
    ).toBe(404);
  });
});
