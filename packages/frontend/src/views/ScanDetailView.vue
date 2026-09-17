<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ScanDetail } from '@chart-monitor/shared';
import { getScan } from '../api/client.js';

const props = defineProps<{ id: string }>();

const scan = ref<ScanDetail | null>(null);
const error = ref<string | null>(null);
let pollHandle: ReturnType<typeof setInterval> | undefined;

const isInProgress = computed(
  () => scan.value?.state === 'pending' || scan.value?.state === 'running',
);

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
    <p
      v-else-if="scan.chartFindings.length === 0 && scan.imageFindings.length === 0"
      class="text-muted"
    >
      The scan finished but found no Helm chart through the supported ApplicationSet generators
      (<code>list</code>, <code>git</code> with <code>directories</code> or <code>files</code>).
      If the repo does use charts, check whether the applications reference charts directly (not
      via a cluster/SCM-provider/PR generator, or a local git path without a <code>chart:</code>
      field).
    </p>

    <section v-if="scan.chartFindings.length > 0" class="card section">
      <h2 class="mono">Chart versions</h2>
      <table>
        <thead>
          <tr>
            <th>Application</th>
            <th>Chart</th>
            <th>Current</th>
            <th>Latest</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="finding in scan.chartFindings" :key="`${finding.applicationName}-${finding.chartName}`">
            <td>{{ finding.applicationName }}</td>
            <td>{{ finding.chartName }}</td>
            <td class="mono">{{ finding.currentVersion }}</td>
            <td class="mono">{{ finding.latestVersion ?? '—' }}</td>
            <td><span :class="`badge badge-${finding.status}`">{{ finding.status }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="scan.imageFindings.length > 0" class="card section">
      <h2 class="mono">Image versions</h2>
      <table>
        <thead>
          <tr>
            <th>Application</th>
            <th>Image</th>
            <th>Current tag</th>
            <th>Latest tag</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="finding in scan.imageFindings" :key="`${finding.applicationName}-${finding.image}`">
            <td>{{ finding.applicationName }}</td>
            <td>{{ finding.image }}</td>
            <td class="mono">{{ finding.currentTag }}</td>
            <td class="mono">{{ finding.latestTag ?? '—' }}</td>
            <td><span :class="`badge badge-${finding.status}`">{{ finding.status }}</span></td>
          </tr>
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
</style>
