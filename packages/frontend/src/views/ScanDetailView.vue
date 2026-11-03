<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import type {
  ChartFinding,
  CveFinding,
  CveSeverityValue,
  ImageFinding,
  ScanDetail,
} from '@chart-monitor/shared';
import { getScan } from '../api/client.js';

const props = defineProps<{ id: string }>();

const scan = ref<ScanDetail | null>(null);
const error = ref<string | null>(null);
let pollHandle: ReturnType<typeof setInterval> | undefined;

const isInProgress = computed(
  () => scan.value?.state === 'pending' || scan.value?.state === 'running',
);

// Worst-to-best. Only MEDIUM+ get a chart-header icon — LOW/UNKNOWN aren't worth flagging at a glance.
const SEVERITY_ORDER: CveSeverityValue[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const SEVERITY_ICON: Partial<Record<CveSeverityValue, string>> = {
  CRITICAL: 'lucide:flame',
  HIGH: 'lucide:alert-octagon',
  MEDIUM: 'lucide:alert-triangle',
};

type SeverityCounts = Partial<Record<CveSeverityValue, number>>;

interface ImageWithCves extends ImageFinding {
  cveCounts: SeverityCounts;
  cves: CveFinding[];
}

function sortBySeverity(cves: CveFinding[]): CveFinding[] {
  return [...cves].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

interface ChartGroup {
  key: string;
  chart: ChartFinding;
  images: ImageWithCves[];
  worstSeverity: CveSeverityValue | null;
}

function countBySeverity(severities: CveSeverityValue[]): SeverityCounts {
  const counts: SeverityCounts = {};
  for (const severity of severities) counts[severity] = (counts[severity] ?? 0) + 1;
  return counts;
}

function worstSeverityOf(counts: SeverityCounts): CveSeverityValue | null {
  return SEVERITY_ORDER.find((severity) => (counts[severity] ?? 0) > 0) ?? null;
}

// CVE/image findings only carry `applicationName`, not which chart they came from — fine in
// practice since each application currently resolves to a single chart source, but two chart
// sources sharing one applicationName would incorrectly merge here.
const chartGroups = computed<ChartGroup[]>(() => {
  if (!scan.value) return [];
  const { chartFindings, imageFindings, cveFindings } = scan.value;

  return chartFindings.map((chart) => {
    const images = imageFindings
      .filter((image) => image.applicationName === chart.applicationName)
      .map((image): ImageWithCves => {
        const cves = cveFindings.filter(
          (cve) => cve.applicationName === chart.applicationName && cve.image === image.image,
        );
        return { ...image, cveCounts: countBySeverity(cves.map((c) => c.severity)), cves };
      });

    const appSeverities = cveFindings
      .filter((cve) => cve.applicationName === chart.applicationName)
      .map((cve) => cve.severity);

    return {
      key: `${chart.applicationName}-${chart.chartName}`,
      chart,
      images,
      worstSeverity: worstSeverityOf(countBySeverity(appSeverities)),
    };
  });
});

const expandedKeys = ref(new Set<string>());
const expandedImageKeys = ref(new Set<string>());

function toggleIn(set: Set<string>, key: string) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

async function refresh() {
  try {
    scan.value = await getScan(props.id);
    if (!isInProgress.value && pollHandle) {
      clearInterval(pollHandle);
      pollHandle = undefined;
    }
  } catch {
    error.value = 'Scan not found.';
    if (pollHandle) clearInterval(pollHandle);
  }
}

onMounted(async () => {
  await refresh();
  if (isInProgress.value) {
    pollHandle = setInterval(refresh, 3000);
  }
});

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle);
});
</script>

<template>
  <p v-if="error" class="text-muted">{{ error }}</p>

  <template v-else-if="scan">
    <div class="header-row">
      <div>
        <h1 class="mono">{{ scan.repoUrl }}</h1>
        <p class="text-muted">{{ new Date(scan.createdAt).toLocaleString('en-US') }}</p>
      </div>
      <span :class="`badge badge-${scan.state}`">{{ scan.state }}</span>
    </div>

    <p v-if="scan.errorMessage" class="error">{{ scan.errorMessage }}</p>
    <p v-else-if="isInProgress" class="text-muted">Scan is running, results will appear automatically…</p>
    <p v-else-if="chartGroups.length === 0" class="text-muted">
      The scan finished but found no Helm chart through the supported ApplicationSet generators
      (<code>list</code>, <code>git</code> with <code>directories</code> or <code>files</code>).
      If the repo does use charts, check whether the applications reference charts directly (not
      via a cluster/SCM-provider/PR generator, or a local git path without a <code>chart:</code>
      field).
    </p>

    <section v-else class="card section">
      <h2 class="mono">Chart versions</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Application</th>
            <th>Chart</th>
            <th>Current</th>
            <th>Latest</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in chartGroups" :key="group.key">
            <tr class="chart-row" @click="toggleIn(expandedKeys, group.key)">
              <td class="expand-cell">
                <Icon :icon="expandedKeys.has(group.key) ? 'lucide:chevron-down' : 'lucide:chevron-right'" />
              </td>
              <td>
                {{ group.chart.applicationName }}
                <Icon
                  v-if="group.worstSeverity && SEVERITY_ICON[group.worstSeverity]"
                  :icon="SEVERITY_ICON[group.worstSeverity] as string"
                  :class="['severity-icon', group.worstSeverity.toLowerCase()]"
                  :title="`Worst vulnerability severity: ${group.worstSeverity}`"
                />
              </td>
              <td>{{ group.chart.chartName }}</td>
              <td class="mono"><span class="truncate" :title="group.chart.currentVersion">{{ group.chart.currentVersion }}</span></td>
              <td class="mono"><span class="truncate" :title="group.chart.latestVersion ?? undefined">{{ group.chart.latestVersion ?? '—' }}</span></td>
              <td><span :class="`badge badge-${group.chart.status}`">{{ group.chart.status }}</span></td>
            </tr>
            <tr v-if="expandedKeys.has(group.key)" class="expanded-row">
              <td colspan="6">
                <p v-if="group.images.length === 0" class="text-muted">No images found for this chart.</p>
                <div v-else class="table-scroll">
                <table class="nested-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Image</th>
                      <th>Current tag</th>
                      <th>Latest tag</th>
                      <th>Status</th>
                      <th>Vulnerabilities</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="image in group.images" :key="image.image">
                      <tr
                        :class="['image-row', { clickable: image.cves.length > 0 }]"
                        @click="image.cves.length > 0 && toggleIn(expandedImageKeys, `${group.key}-${image.image}`)"
                      >
                        <td class="expand-cell">
                          <Icon
                            v-if="image.cves.length > 0"
                            :icon="expandedImageKeys.has(`${group.key}-${image.image}`) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                          />
                        </td>
                        <td>{{ image.image }}</td>
                        <td class="mono"><span class="truncate" :title="image.currentTag">{{ image.currentTag }}</span></td>
                        <td class="mono"><span class="truncate" :title="image.latestTag ?? undefined">{{ image.latestTag ?? '—' }}</span></td>
                        <td><span :class="`badge badge-${image.status}`">{{ image.status }}</span></td>
                        <td>
                          <span
                            v-for="severity in SEVERITY_ORDER.filter((s) => image.cveCounts[s])"
                            :key="severity"
                            :class="['cve-count', severity.toLowerCase()]"
                            :title="`${image.cveCounts[severity]} ${severity} severity`"
                          >
                            {{ image.cveCounts[severity] }}
                          </span>
                          <span v-if="image.cves.length === 0" class="text-muted">—</span>
                        </td>
                      </tr>
                      <tr v-if="expandedImageKeys.has(`${group.key}-${image.image}`)" class="expanded-row">
                        <td colspan="6">
                          <div class="table-scroll">
                          <table class="nested-table">
                            <thead>
                              <tr>
                                <th>Vulnerability</th>
                                <th>Package</th>
                                <th>Installed</th>
                                <th>Fixed</th>
                                <th>Severity</th>
                                <th>Title</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="cve in sortBySeverity(image.cves)" :key="cve.vulnerabilityId + cve.pkgName">
                                <td class="mono">{{ cve.vulnerabilityId }}</td>
                                <td><span class="truncate" :title="cve.pkgName">{{ cve.pkgName }}</span></td>
                                <td class="mono"><span class="truncate" :title="cve.installedVersion">{{ cve.installedVersion }}</span></td>
                                <td class="mono"><span class="truncate" :title="cve.fixedVersion ?? undefined">{{ cve.fixedVersion ?? '—' }}</span></td>
                                <td>
                                  <span :class="['severity-badge', cve.severity.toLowerCase()]">{{ cve.severity }}</span>
                                </td>
                                <td class="text-muted"><span class="truncate-title" :title="cve.title ?? undefined">{{ cve.title ?? '—' }}</span></td>
                              </tr>
                            </tbody>
                          </table>
                          </div>
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>
  </template>
</template>

<style scoped>
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-6);
}
.section {
  margin-bottom: var(--space-6);
}
.section h2 {
  margin-bottom: var(--space-4);
}
.error {
  color: #ef4444;
}

.chart-row {
  cursor: pointer;
}
.chart-row:hover {
  background-color: var(--color-bg-subtle);
}

.image-row.clickable {
  cursor: pointer;
}
.image-row.clickable:hover {
  background-color: var(--color-bg);
}
.expand-cell {
  width: 1.5rem;
  color: var(--color-text-muted);
}

.expanded-row td {
  padding: 0 var(--space-4) var(--space-4);
  background-color: var(--color-bg-subtle);
}
.table-scroll {
  overflow-x: auto;
  margin-top: var(--space-2);
}
.nested-table {
  width: 100%;
}
.nested-table th,
.nested-table td {
  padding: var(--space-2) var(--space-3);
  white-space: nowrap;
}

.truncate {
  display: inline-block;
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.truncate-title {
  display: inline-block;
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.severity-icon {
  vertical-align: -0.15em;
  margin-left: var(--space-1);
}
.severity-icon.medium {
  color: #eab308;
}
.severity-icon.high {
  color: #f97316;
}
.severity-icon.critical {
  color: #ef4444;
}

.cve-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5em;
  padding: 0 var(--space-1);
  margin-right: var(--space-1);
  border-radius: var(--radius-sm);
  font-family: 'DM Mono', monospace;
  font-size: 0.8rem;
  font-weight: 500;
}
.cve-count.critical {
  background-color: color-mix(in srgb, #ef4444 20%, transparent);
  color: #ef4444;
}
.cve-count.high {
  background-color: color-mix(in srgb, #f97316 20%, transparent);
  color: #f97316;
}
.cve-count.medium {
  background-color: color-mix(in srgb, #eab308 20%, transparent);
  color: #eab308;
}
.cve-count.low,
.cve-count.unknown {
  background-color: var(--color-bg);
  color: var(--color-text-muted);
}

.severity-badge {
  display: inline-flex;
  font-family: 'DM Mono', monospace;
  font-size: 0.8rem;
  font-weight: 500;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
}
.severity-badge.critical {
  background-color: color-mix(in srgb, #ef4444 20%, transparent);
  color: #ef4444;
}
.severity-badge.high {
  background-color: color-mix(in srgb, #f97316 20%, transparent);
  color: #f97316;
}
.severity-badge.medium {
  background-color: color-mix(in srgb, #eab308 20%, transparent);
  color: #eab308;
}
.severity-badge.low,
.severity-badge.unknown {
  background-color: var(--color-bg);
  color: var(--color-text-muted);
}
</style>
