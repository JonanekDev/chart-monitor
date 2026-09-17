<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ScanSummary } from '@chart-monitor/shared';
import { listScans } from '../api/client.js';

const scans = ref<ScanSummary[]>([]);
const isLoading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    scans.value = await listScans();
  } catch {
    error.value = 'Failed to load scans.';
  } finally {
    isLoading.value = false;
  }
});
</script>

<template>
  <div class="header-row">
    <h1 class="mono">Scans</h1>
    <RouterLink to="/scans/new" class="btn-primary">New scan</RouterLink>
  </div>

  <p v-if="isLoading" class="text-muted">Loading…</p>
  <p v-else-if="error" class="text-muted">{{ error }}</p>
  <p v-else-if="scans.length === 0" class="text-muted">
    No scans yet. Start one via "New scan".
  </p>

  <div v-else class="card">
    <table>
      <thead>
        <tr>
          <th>Repo</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="scan in scans" :key="scan.id">
          <td>
            <RouterLink :to="`/scans/${scan.id}`">{{ scan.repoUrl }}</RouterLink>
          </td>
          <td><span :class="`badge badge-${scan.state}`">{{ scan.state }}</span></td>
          <td class="text-muted">{{ new Date(scan.createdAt).toLocaleString('en-US') }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-6);
}
</style>
