<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import type { Monitor, ScanSummary } from '@chart-monitor/shared';
import { ApiError, deleteMonitor, listMonitors, runMonitor, updateMonitor } from '../api/client.js';
import { describeSchedule, formatDateTime, relativeTime } from '../schedules.js';

const router = useRouter();
const monitors = ref<Monitor[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);
const expanded = ref(new Set<string>());
const busy = ref(new Set<string>());

const PHASE_LABEL: Record<string, string> = {
  cloning: 'Cloning',
  resolving: 'Finding apps',
  chart_versions: 'Chart versions',
  images: 'Finding images',
  vulnerabilities: 'Scanning images',
};

const isActive = (scan: ScanSummary | undefined) =>
  scan?.state === 'pending' || scan?.state === 'running';
const anyActive = computed(() => monitors.value.some((m) => isActive(m.scans[0])));

/** Headline numbers come from the newest successful scan, so a failed run doesn't blank them */
const lastSucceeded = (monitor: Monitor) => monitor.scans.find((s) => s.state === 'succeeded');

function repoLabel(monitor: Monitor): string {
  const name = monitor.repoUrl
    .replace(/^(https?:\/\/|ssh:\/\/)?([^@/]+@)?[^/:]+[/:]/, '')
    .replace(/\.git$/, '');
  return [name, monitor.ref && `@${monitor.ref}`, monitor.searchPath && ` /${monitor.searchPath}`]
    .filter(Boolean)
    .join('');
}

function activeLabel(scan: ScanSummary): string {
  if (scan.state === 'pending') return 'queued';
  const p = scan.progress;
  if (!p) return 'starting';
  return `${PHASE_LABEL[p.phase] ?? p.phase}${p.total ? ` ${p.done}/${p.total}` : ''}`;
}

async function refresh() {
  try {
    monitors.value = await listMonitors();
    error.value = null;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Failed to load monitors.';
  } finally {
    isLoading.value = false;
  }
}

// Poll quickly while a scan is queued or running, slowly otherwise (scheduled runs start by themselves)
let timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  await refresh();
  timer = setTimeout(poll, anyActive.value ? 3000 : 30000);
}
onMounted(poll);
onUnmounted(() => clearTimeout(timer));

async function act(monitor: Monitor, action: () => Promise<unknown>) {
  busy.value.add(monitor.id);
  try {
    await action();
    await refresh();
  } catch (e) {
    window.alert(e instanceof ApiError ? e.message : 'Action failed.');
  } finally {
    busy.value.delete(monitor.id);
  }
}

const run = (m: Monitor) => act(m, () => runMonitor(m.id));
const togglePause = (m: Monitor) => act(m, () => updateMonitor(m.id, { enabled: !m.enabled }));
function remove(m: Monitor) {
  if (!window.confirm(`Delete monitor ${repoLabel(m)} and all its scans?`)) return;
  void act(m, () => deleteMonitor(m.id));
}

function toggle(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id);
  else expanded.value.add(id);
}
</script>

<template>
  <div class="header-row">
    <h1 class="mono">Monitors</h1>
    <RouterLink to="/monitors/new" class="btn-primary">New monitor</RouterLink>
  </div>

  <p v-if="isLoading" class="text-muted">Loading…</p>
  <p v-else-if="error" class="error">{{ error }}</p>
  <p v-else-if="monitors.length === 0" class="text-muted">
    Nothing monitored yet. Add a GitOps repo via "New monitor"; its first scan starts right away.
  </p>

  <div v-else class="card table-card">
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Repository</th>
            <th>Schedule</th>
            <th>Outdated</th>
            <th>Crit / High</th>
            <th>Last scan</th>
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="monitor in monitors" :key="monitor.id">
            <tr class="monitor-row" @click="toggle(monitor.id)">
              <td class="expand-cell">
                <Icon
                  :icon="expanded.has(monitor.id) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                />
              </td>
              <td class="mono repo" :title="monitor.repoUrl">{{ repoLabel(monitor) }}</td>
              <td>
                <span :class="{ 'text-muted': !monitor.enabled }">{{
                  describeSchedule(monitor.schedule)
                }}</span>
                <span v-if="!monitor.enabled" class="paused">paused</span>
                <div
                  v-else-if="monitor.nextRunAt"
                  class="text-muted sub"
                  :title="formatDateTime(monitor.nextRunAt)"
                >
                  next {{ relativeTime(monitor.nextRunAt) }}
                </div>
              </td>
              <template v-if="lastSucceeded(monitor)">
                <td class="mono">{{ lastSucceeded(monitor)!.counts.outdatedCharts }}</td>
                <td class="mono">
                  <span :class="{ critical: lastSucceeded(monitor)!.counts.critical }">{{
                    lastSucceeded(monitor)!.counts.critical
                  }}</span>
                  /
                  <span :class="{ high: lastSucceeded(monitor)!.counts.high }">{{
                    lastSucceeded(monitor)!.counts.high
                  }}</span>
                </td>
              </template>
              <template v-else>
                <td class="text-muted">–</td>
                <td class="text-muted">–</td>
              </template>
              <td>
                <template v-if="monitor.scans[0]">
                  <span :class="`badge badge-${monitor.scans[0].state}`">
                    {{
                      isActive(monitor.scans[0])
                        ? activeLabel(monitor.scans[0])
                        : monitor.scans[0].state
                    }}
                  </span>
                  <div class="text-muted sub" :title="formatDateTime(monitor.scans[0].createdAt)">
                    {{ relativeTime(monitor.scans[0].createdAt) }}
                  </div>
                </template>
                <span v-else class="text-muted">never</span>
              </td>
              <td class="actions" @click.stop>
                <button
                  class="btn-icon"
                  :disabled="busy.has(monitor.id) || isActive(monitor.scans[0])"
                  :aria-label="`Run ${repoLabel(monitor)} now`"
                  title="Run now"
                  @click="run(monitor)"
                >
                  <Icon icon="lucide:play" />
                </button>
                <RouterLink
                  class="btn-icon"
                  :to="`/monitors/${monitor.id}/edit`"
                  :aria-label="`Edit ${repoLabel(monitor)}`"
                  title="Edit"
                >
                  <Icon icon="lucide:pencil" />
                </RouterLink>
                <button
                  class="btn-icon"
                  :disabled="busy.has(monitor.id) || !monitor.schedule"
                  :aria-label="`${monitor.enabled ? 'Pause' : 'Resume'} schedule of ${repoLabel(monitor)}`"
                  :title="
                    monitor.schedule
                      ? monitor.enabled
                        ? 'Pause schedule'
                        : 'Resume schedule'
                      : 'No schedule to pause'
                  "
                  @click="togglePause(monitor)"
                >
                  <Icon :icon="monitor.enabled ? 'lucide:pause' : 'lucide:calendar-clock'" />
                </button>
                <button
                  class="btn-icon danger"
                  :disabled="busy.has(monitor.id)"
                  :aria-label="`Delete ${repoLabel(monitor)}`"
                  title="Delete"
                  @click="remove(monitor)"
                >
                  <Icon icon="lucide:trash-2" />
                </button>
              </td>
            </tr>

            <tr v-if="expanded.has(monitor.id)" class="expanded-row">
              <td colspan="7">
                <p v-if="monitor.scans.length === 0" class="text-muted">No scans yet.</p>
                <table v-else class="nested-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Started</th>
                      <th>Outdated</th>
                      <th>Crit / High</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="scan in monitor.scans"
                      :key="scan.id"
                      class="scan-row"
                      tabindex="0"
                      @click="router.push(`/scans/${scan.id}`)"
                      @keydown.enter="router.push(`/scans/${scan.id}`)"
                    >
                      <td>
                        <span :class="`badge badge-${scan.state}`">
                          {{ isActive(scan) ? activeLabel(scan) : scan.state }}
                        </span>
                      </td>
                      <td :title="formatDateTime(scan.createdAt)">
                        {{ formatDateTime(scan.createdAt) }}
                      </td>
                      <template v-if="scan.state === 'succeeded'">
                        <td class="mono">{{ scan.counts.outdatedCharts }}</td>
                        <td class="mono">{{ scan.counts.critical }} / {{ scan.counts.high }}</td>
                      </template>
                      <template v-else>
                        <td class="text-muted">–</td>
                        <td class="text-muted">–</td>
                      </template>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}
.error {
  color: #ef4444;
}
.table-card {
  padding: 0;
}
.table-scroll {
  overflow-x: auto;
}
.monitor-row,
.scan-row {
  cursor: pointer;
}
.monitor-row:hover,
.scan-row:hover {
  background-color: var(--color-bg-subtle);
}
.expand-cell {
  width: 1.5rem;
  color: var(--color-text-muted);
}
.repo {
  max-width: 22rem;
  overflow-wrap: anywhere;
}
.sub {
  font-size: 0.8rem;
  margin-top: var(--space-1);
}
.paused {
  margin-left: var(--space-2);
  font-size: 0.8rem;
  color: var(--color-accent);
}
.critical {
  color: #ef4444;
  font-weight: 600;
}
.high {
  color: #f97316;
}
.actions {
  white-space: nowrap;
  text-align: right;
}
.expanded-row > td {
  background-color: var(--color-bg-subtle);
  padding: 0 var(--space-4) var(--space-4) var(--space-12);
}
.nested-table th,
.nested-table td {
  padding: var(--space-2) var(--space-3);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
