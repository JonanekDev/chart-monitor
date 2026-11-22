<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import {
  countBySeverity,
  SEVERITIES,
  type ChartFindingDetail,
  type ChartUpgrade,
  type CveFinding,
  type CveSeverityValue,
  type ImageFinding,
  type ScanDetail,
  type ScanPhaseValue,
  type SeverityCounts,
} from '@chart-monitor/shared';
import { getScan } from '../api/client.js';

const props = defineProps<{ id: string }>();

const scan = ref<ScanDetail | null>(null);
const error = ref<string | null>(null);
let pollHandle: ReturnType<typeof setInterval> | undefined;

const isInProgress = computed(
  () => scan.value?.state === 'pending' || scan.value?.state === 'running',
);

// Same order as the backend runs them
const STEPS: { phase: ScanPhaseValue; label: string }[] = [
  { phase: 'cloning', label: 'Cloning repository' },
  { phase: 'resolving', label: 'Finding ArgoCD applications' },
  { phase: 'chart_versions', label: 'Checking chart versions' },
  { phase: 'images', label: 'Finding images in charts' },
  { phase: 'upgrades', label: 'Comparing with the latest chart versions' },
  { phase: 'vulnerabilities', label: 'Scanning images for vulnerabilities' },
];
type StepStatus = 'done' | 'active' | 'failed' | 'todo';
const STEP_ICON: Record<StepStatus, string> = {
  done: 'lucide:circle-check',
  active: 'lucide:loader-circle',
  failed: 'lucide:circle-x',
  todo: 'lucide:circle-dashed',
};

const currentStep = computed(() =>
  STEPS.findIndex((step) => step.phase === scan.value?.progress?.phase),
);

// Images are only known once the "images" step is over
const imagesPending = computed(
  () =>
    isInProgress.value && currentStep.value <= STEPS.findIndex((step) => step.phase === 'images'),
);

function stepStatus(index: number): StepStatus {
  if (index < currentStep.value) return 'done';
  if (index > currentStep.value) return 'todo';
  return scan.value?.state === 'failed' ? 'failed' : 'active';
}

// Worst-to-best. Only MEDIUM+ get a chart-header icon — LOW/UNKNOWN aren't worth flagging at a glance.
const SEVERITY_ORDER = SEVERITIES;
const SEVERITY_ICON: Partial<Record<CveSeverityValue, string>> = {
  CRITICAL: 'lucide:flame',
  HIGH: 'lucide:alert-octagon',
  MEDIUM: 'lucide:alert-triangle',
};

interface ImageWithCves extends ImageFinding {
  cveCounts: SeverityCounts;
  cves: CveFinding[];
}

function sortBySeverity(cves: CveFinding[]): CveFinding[] {
  return [...cves].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
}

interface ChartGroup {
  key: string;
  chart: ChartFindingDetail;
  images: ImageWithCves[];
  /** Distinct ids across all of the app's images (not the sum of the image rows) */
  cveCounts: SeverityCounts;
  worstSeverity: CveSeverityValue | null;
}

const describeCounts = (counts: SeverityCounts) =>
  Object.entries(counts)
    .map(([severity, n]) => `${n} ${severity.toLowerCase()}`)
    .join(', ');

// Black Duck advisories often describe the same issue as a CVE under another id
const isVendorAdvisory = (id: string) => id.startsWith('BDSA-');

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
        return { ...image, cveCounts: countBySeverity(cves), cves };
      });

    const cveCounts = countBySeverity(
      cveFindings.filter((cve) => cve.applicationName === chart.applicationName),
    );
    return {
      key: `${chart.applicationName}-${chart.chartName}`,
      chart,
      images,
      cveCounts,
      worstSeverity: SEVERITIES.find((severity) => cveCounts[severity]) ?? null,
    };
  });
});

function upgradeRisky({ upgrade }: ChartFindingDetail): boolean {
  return (
    !!upgrade &&
    (!!upgrade.renderError ||
      upgrade.removedValues.length > 0 ||
      upgrade.manifestChanges.some((c) => c.immutableFields.length > 0))
  );
}

const addedOrRemoved = ({ manifestChanges }: ChartUpgrade) =>
  manifestChanges.filter((c) => c.change !== 'changed');

function changeSummary(upgrade: ChartUpgrade): string {
  const changes = addedOrRemoved(upgrade);
  return (['added', 'removed'] as const)
    .map((kind) => [kind, changes.filter((c) => c.change === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${n === 1 ? 'resource' : 'resources'} ${kind}`)
    .join(', ');
}

function vulnerabilitySides(vulns: NonNullable<ChartUpgrade['vulnerabilities']>) {
  return [
    { label: 'Fixes', short: 'fixed', list: vulns.fixed },
    { label: 'Adds', short: 'new', list: vulns.introduced },
  ].map((side) => ({ ...side, counts: countBySeverity(side.list) }));
}

/** An outdated image is yours to bump only when its tag isn't simply the chart's default */
function imageStatus(image: ImageFinding, chart: ChartFindingDetail) {
  if (image.status !== 'outdated' || image.tagSource !== 'chart') {
    return { label: image.status, badge: image.status, title: undefined };
  }
  return chart.status === 'outdated'
    ? {
        label: 'via chart upgrade',
        badge: 'unknown',
        title: "The chart's default tag: upgrading the chart brings a newer one",
      }
    : {
        label: 'newer upstream',
        badge: 'unknown',
        title: "The chart's default tag: a newer one exists, but the chart doesn't ship it yet",
      };
}

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
    <RouterLink to="/" class="back text-muted"
      ><Icon icon="lucide:arrow-left" /> Monitors</RouterLink
    >
    <div class="header-row">
      <div>
        <h1 class="mono">{{ scan.repoUrl }}</h1>
        <p class="text-muted">{{ new Date(scan.createdAt).toLocaleString('en-US') }}</p>
      </div>
      <span :class="`badge badge-${scan.state}`">{{ scan.state }}</span>
    </div>

    <details v-if="scan.warnings?.length" class="card section warnings">
      <summary>
        <Icon icon="lucide:alert-triangle" class="warnings-icon" />
        {{ scan.warnings.length }} {{ scan.warnings.length === 1 ? 'item was' : 'items were' }}
        skipped or could not be fully processed
      </summary>
      <ul>
        <li v-for="warning in scan.warnings" :key="warning">{{ warning }}</li>
      </ul>
    </details>

    <section v-if="isInProgress || scan.progress" class="card section">
      <p v-if="!scan.progress" class="text-muted">Waiting to start…</p>
      <ol v-else class="steps">
        <li v-for="(step, i) in STEPS" :key="step.phase" :class="['step', stepStatus(i)]">
          <Icon :icon="STEP_ICON[stepStatus(i)]" class="step-icon" />
          <span>{{ step.label }}</span>
          <span v-if="i === currentStep && scan.progress.total" class="text-muted mono">
            {{ scan.progress.done }} / {{ scan.progress.total }}
          </span>
        </li>
      </ol>
      <template v-if="isInProgress && scan.progress?.total">
        <progress :value="scan.progress.done" :max="scan.progress.total" />
        <p v-if="scan.progress.detail" class="text-muted step-detail mono">
          Last finished: {{ scan.progress.detail }}
        </p>
      </template>
    </section>

    <p v-if="scan.errorMessage" class="error section">{{ scan.errorMessage }}</p>

    <p
      v-if="!isInProgress && scan.state !== 'failed' && chartGroups.length === 0"
      class="text-muted"
    >
      The scan finished but found no Helm chart. Applications with only git paths (plain manifests,
      kustomize) have no chart to check;{{ ' ' }}
      <template v-if="scan.warnings?.length"
        >the skipped items above explain what else was left out.</template
      >
      <template v-else>nothing was skipped.</template>
    </p>

    <section v-if="chartGroups.length > 0" class="card section">
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
                <Icon
                  :icon="
                    expandedKeys.has(group.key) ? 'lucide:chevron-down' : 'lucide:chevron-right'
                  "
                />
              </td>
              <td>
                {{ group.chart.applicationName }}
                <Icon
                  v-if="group.worstSeverity && SEVERITY_ICON[group.worstSeverity]"
                  :icon="SEVERITY_ICON[group.worstSeverity] as string"
                  :class="['severity-icon', group.worstSeverity.toLowerCase()]"
                  :title="`Vulnerabilities across all images: ${describeCounts(group.cveCounts)}`"
                />
              </td>
              <td>{{ group.chart.chartName }}</td>
              <td class="mono">
                <span class="truncate" :title="group.chart.currentVersion">{{
                  group.chart.currentVersion
                }}</span>
              </td>
              <td class="mono">
                <span class="truncate" :title="group.chart.latestVersion ?? undefined">{{
                  group.chart.latestVersion ?? '—'
                }}</span>
              </td>
              <td>
                <span :class="`badge badge-${group.chart.status}`">{{ group.chart.status }}</span>
                <Icon
                  v-if="upgradeRisky(group.chart)"
                  icon="lucide:alert-triangle"
                  class="severity-icon medium"
                  title="Upgrading to the latest version needs attention"
                />
              </td>
            </tr>
            <tr v-if="expandedKeys.has(group.key)" class="expanded-row">
              <td colspan="6">
                <div v-if="group.chart.upgrade" class="upgrade">
                  <h3>Upgrade to {{ group.chart.latestVersion }}</h3>
                  <p v-if="group.chart.upgrade.renderError" class="error mono">
                    Does not render with your values: {{ group.chart.upgrade.renderError }}
                  </p>
                  <p v-if="group.chart.upgrade.removedValues.length">
                    Values you set that the new chart no longer has (Helm ignores them):
                    <code v-for="key in group.chart.upgrade.removedValues" :key="key">{{
                      key
                    }}</code>
                  </p>
                  <p
                    v-if="
                      !group.chart.upgrade.renderError &&
                      addedOrRemoved(group.chart.upgrade).length === 0
                    "
                    class="text-muted"
                  >
                    No resources added or removed.
                  </p>
                  <p
                    v-for="change in group.chart.upgrade.manifestChanges.filter(
                      (c) => c.immutableFields.length,
                    )"
                    :key="change.resource"
                    class="immutable"
                  >
                    <Icon icon="lucide:alert-triangle" />
                    <span>
                      <span class="mono">{{ change.resource }}</span>: immutable
                      {{ change.immutableFields.join(', ') }} changes, the sync fails until the
                      resource is deleted and recreated
                    </span>
                  </p>
                  <details v-if="addedOrRemoved(group.chart.upgrade).length">
                    <summary class="changes-summary">
                      {{ changeSummary(group.chart.upgrade) }}
                    </summary>
                    <ul class="resource-list">
                      <li
                        v-for="change in addedOrRemoved(group.chart.upgrade)"
                        :key="change.resource"
                      >
                        <span :class="['change-badge', change.change]">{{ change.change }}</span>
                        <span class="mono">{{ change.resource }}</span>
                      </li>
                    </ul>
                  </details>
                  <template v-if="group.chart.upgrade.vulnerabilities">
                    <p
                      v-if="
                        group.chart.upgrade.vulnerabilities.fixed.length === 0 &&
                        group.chart.upgrade.vulnerabilities.introduced.length === 0
                      "
                      class="text-muted"
                    >
                      Same vulnerabilities as the current version.
                    </p>
                    <details v-else>
                      <summary class="changes-summary">
                        <template
                          v-for="side in vulnerabilitySides(group.chart.upgrade.vulnerabilities)"
                          :key="side.label"
                        >
                          <span v-if="side.list.length" class="vuln-side">
                            {{ side.label }}
                            <span
                              v-for="severity in SEVERITY_ORDER.filter((s) => side.counts[s])"
                              :key="severity"
                              :class="['cve-count', severity.toLowerCase()]"
                              :title="`${side.counts[severity]} ${severity} severity`"
                              >{{ side.counts[severity] }}</span
                            >
                          </span>
                        </template>
                      </summary>
                      <div class="table-scroll">
                        <table class="nested-table">
                          <thead>
                            <tr>
                              <th></th>
                              <th>Vulnerability</th>
                              <th>Package</th>
                              <th>Severity</th>
                              <th>Image</th>
                              <th>Title</th>
                            </tr>
                          </thead>
                          <tbody>
                            <template
                              v-for="side in vulnerabilitySides(
                                group.chart.upgrade.vulnerabilities,
                              )"
                              :key="side.label"
                            >
                              <tr v-for="cve in side.list" :key="cve.vulnerabilityId + cve.pkgName">
                                <td class="text-muted">{{ side.short }}</td>
                                <td
                                  :class="[
                                    'mono',
                                    { 'vendor-advisory': isVendorAdvisory(cve.vulnerabilityId) },
                                  ]"
                                  :title="
                                    isVendorAdvisory(cve.vulnerabilityId)
                                      ? 'Black Duck advisory: may describe the same issue as a CVE listed here'
                                      : undefined
                                  "
                                >
                                  {{ cve.vulnerabilityId }}
                                </td>
                                <td>
                                  <span class="truncate" :title="cve.pkgName">{{
                                    cve.pkgName
                                  }}</span>
                                </td>
                                <td>
                                  <span :class="['severity-badge', cve.severity.toLowerCase()]">{{
                                    cve.severity
                                  }}</span>
                                </td>
                                <td>
                                  <span class="truncate" :title="cve.image">{{ cve.image }}</span>
                                </td>
                                <td class="text-muted">
                                  <span class="truncate-title" :title="cve.title ?? undefined">{{
                                    cve.title ?? '—'
                                  }}</span>
                                </td>
                              </tr>
                            </template>
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </template>
                  <p v-else-if="!group.chart.upgrade.renderError" class="text-muted">
                    {{
                      isInProgress
                        ? 'Scanning the new version’s images…'
                        : 'Vulnerabilities of the new version could not be determined; the skipped items above say why.'
                    }}
                  </p>
                </div>
                <p v-if="group.images.length === 0" class="text-muted">
                  {{ imagesPending ? 'Finding images…' : 'No images found for this chart.' }}
                </p>
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
                          @click="
                            image.cves.length > 0 &&
                            toggleIn(expandedImageKeys, `${group.key}-${image.image}`)
                          "
                        >
                          <td class="expand-cell">
                            <Icon
                              v-if="image.cves.length > 0"
                              :icon="
                                expandedImageKeys.has(`${group.key}-${image.image}`)
                                  ? 'lucide:chevron-down'
                                  : 'lucide:chevron-right'
                              "
                            />
                          </td>
                          <td>{{ image.image }}</td>
                          <td class="mono">
                            <span class="truncate" :title="image.currentTag">{{
                              image.currentTag
                            }}</span>
                          </td>
                          <td class="mono">
                            <span class="truncate" :title="image.latestTag ?? undefined">{{
                              image.latestTag ?? '—'
                            }}</span>
                            <div v-if="image.latestTagCheck" class="latest-check">
                              <template v-if="image.latestTagCheck.result === 'scanned'">
                                <template
                                  v-for="side in vulnerabilitySides(image.latestTagCheck)"
                                  :key="side.label"
                                >
                                  <span v-if="side.list.length" class="vuln-side">
                                    {{ side.label.toLowerCase() }}
                                    <span
                                      v-for="severity in SEVERITY_ORDER.filter(
                                        (s) => side.counts[s],
                                      )"
                                      :key="severity"
                                      :class="['cve-count', severity.toLowerCase()]"
                                      :title="`${side.counts[severity]} ${severity} severity`"
                                      >{{ side.counts[severity] }}</span
                                    >
                                  </span>
                                </template>
                                <span
                                  v-if="
                                    !image.latestTagCheck.fixed.length &&
                                    !image.latestTagCheck.introduced.length
                                  "
                                  class="text-muted"
                                  >same vulnerabilities</span
                                >
                              </template>
                              <span v-else class="text-muted">{{
                                image.latestTagCheck.result === 'variant_unclear'
                                  ? 'not scanned (variant unclear)'
                                  : 'scan failed'
                              }}</span>
                            </div>
                          </td>
                          <td>
                            <span
                              :class="`badge badge-${imageStatus(image, group.chart).badge}`"
                              :title="imageStatus(image, group.chart).title"
                              >{{ imageStatus(image, group.chart).label }}</span
                            >
                          </td>
                          <td>
                            <span
                              v-for="severity in SEVERITY_ORDER.filter((s) => image.cveCounts[s])"
                              :key="severity"
                              :class="['cve-count', severity.toLowerCase()]"
                              :title="`${image.cveCounts[severity]} ${severity} severity`"
                            >
                              {{ image.cveCounts[severity] }}
                            </span>
                            <span v-if="!image.vulnerabilitiesScanned" class="text-muted">
                              {{ isInProgress ? 'scanning…' : 'not scanned' }}
                            </span>
                            <span v-else-if="image.cves.length === 0" class="text-muted">none</span>
                          </td>
                        </tr>
                        <tr
                          v-if="expandedImageKeys.has(`${group.key}-${image.image}`)"
                          class="expanded-row"
                        >
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
                                  <tr
                                    v-for="cve in sortBySeverity(image.cves)"
                                    :key="cve.vulnerabilityId + cve.pkgName"
                                  >
                                    <td
                                      :class="[
                                        'mono',
                                        {
                                          'vendor-advisory': isVendorAdvisory(cve.vulnerabilityId),
                                        },
                                      ]"
                                      :title="
                                        isVendorAdvisory(cve.vulnerabilityId)
                                          ? 'Black Duck advisory: may describe the same issue as a CVE listed here'
                                          : undefined
                                      "
                                    >
                                      {{ cve.vulnerabilityId }}
                                    </td>
                                    <td>
                                      <span class="truncate" :title="cve.pkgName">{{
                                        cve.pkgName
                                      }}</span>
                                    </td>
                                    <td class="mono">
                                      <span class="truncate" :title="cve.installedVersion">{{
                                        cve.installedVersion
                                      }}</span>
                                    </td>
                                    <td class="mono">
                                      <span
                                        class="truncate"
                                        :title="cve.fixedVersion ?? undefined"
                                        >{{ cve.fixedVersion ?? '—' }}</span
                                      >
                                    </td>
                                    <td>
                                      <span
                                        :class="['severity-badge', cve.severity.toLowerCase()]"
                                        >{{ cve.severity }}</span
                                      >
                                    </td>
                                    <td class="text-muted">
                                      <span
                                        class="truncate-title"
                                        :title="cve.title ?? undefined"
                                        >{{ cve.title ?? '—' }}</span
                                      >
                                    </td>
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
.back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-4);
}
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

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}
.step {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.step.todo {
  color: var(--color-text-muted);
}
.step-icon {
  flex-shrink: 0;
}
.step.done .step-icon {
  color: var(--color-primary);
}
.step.failed .step-icon {
  color: #ef4444;
}
.step.active .step-icon {
  animation: spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .step.active .step-icon {
    animation: none;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
progress {
  width: 100%;
  margin-top: var(--space-4);
  accent-color: var(--color-primary);
}
.step-detail {
  margin-top: var(--space-2);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

.warnings summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.warnings-icon {
  color: #eab308;
  flex-shrink: 0;
}
.warnings ul {
  margin: var(--space-4) 0 0;
  padding-left: var(--space-6);
  color: var(--color-text-muted);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.warnings li + li {
  margin-top: var(--space-2);
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

.upgrade {
  margin-top: var(--space-4);
  margin-bottom: var(--space-4);
  display: grid;
  gap: var(--space-2);
}
.upgrade h3 {
  font-size: 1rem;
}
.upgrade code {
  margin-left: var(--space-1);
}
.changes-summary {
  cursor: pointer;
}
.latest-check {
  margin-top: var(--space-1);
  font-family: inherit;
  font-size: 0.8rem;
  white-space: nowrap;
}
.vendor-advisory {
  color: var(--color-text-muted);
  font-style: italic;
}
.vuln-side {
  margin-right: var(--space-3);
}
.resource-list {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  display: grid;
  gap: var(--space-1);
}
.change-badge {
  font-family: 'DM Mono', monospace;
  font-size: 0.8rem;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg);
  color: var(--color-text-muted);
}
.change-badge.added {
  color: var(--color-primary);
}
.change-badge.removed {
  color: #ef4444;
}
.immutable {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: #f97316;
  font-size: 0.875rem;
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
