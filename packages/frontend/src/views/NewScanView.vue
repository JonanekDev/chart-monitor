<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { createScanRequestSchema } from '@chart-monitor/shared';
import { createScan } from '../api/client.js';

const router = useRouter();
const repoUrl = ref('');
const searchPath = ref('');
const ref_ = ref('');
const fieldError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const isSubmitting = ref(false);

async function onSubmit() {
  fieldError.value = null;
  submitError.value = null;

  const parsed = createScanRequestSchema.safeParse({
    repoUrl: repoUrl.value,
    searchPath: searchPath.value || undefined,
    ref: ref_.value || undefined,
  });
  if (!parsed.success) {
    fieldError.value = parsed.error.issues[0]?.message ?? 'Invalid input';
    return;
  }

  isSubmitting.value = true;
  try {
    const scan = await createScan(parsed.data);
    router.push(`/scans/${scan.id}`);
  } catch {
    submitError.value = 'Failed to start scan.';
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <h1 class="mono" style="margin-bottom: var(--space-6)">New scan</h1>

  <form class="card" @submit.prevent="onSubmit">
    <div class="field">
      <label for="repoUrl">GitOps repo URL</label>
      <input
        id="repoUrl"
        v-model="repoUrl"
        type="url"
        placeholder="https://github.com/rizek/gitops-repo"
        required
      />
    </div>

    <div class="field">
      <label for="searchPath">Path in repo (optional)</label>
      <input id="searchPath" v-model="searchPath" type="text" placeholder="argocd/applicationsets" />
    </div>

    <div class="field">
      <label for="ref">Branch / ref (optional, defaults to the default branch)</label>
      <input id="ref" v-model="ref_" type="text" placeholder="main" />
    </div>

    <p v-if="fieldError" class="error">{{ fieldError }}</p>
    <p v-if="submitError" class="error">{{ submitError }}</p>

    <button type="submit" class="btn-primary" :disabled="isSubmitting">
      {{ isSubmitting ? 'Starting…' : 'Start scan' }}
    </button>
  </form>
</template>

<style scoped>
.field {
  margin-bottom: var(--space-4);
}
.error {
  color: #ef4444;
  margin-bottom: var(--space-4);
}
</style>
