<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  DEFAULT_NOTIFICATIONS,
  monitorInputSchema,
  type Channel,
  type MonitorNotifications,
  type SchedulePreview,
} from '@chart-monitor/shared';
import {
  ApiError,
  createMonitor,
  listChannels,
  listMonitors,
  previewSchedule,
  updateMonitor,
} from '../api/client.js';
import { formatDateTime, SCHEDULE_PRESETS } from '../schedules.js';

/** Set when editing an existing monitor */
const props = defineProps<{ id?: string }>();
const router = useRouter();

const CUSTOM = 'custom';
const repoUrl = ref('');
const searchPath = ref('');
const ref_ = ref('');
// A preset's cron value, '' for manual only, or CUSTOM
const scheduleChoice = ref<string>('0 3 * * *');
const customSchedule = ref('');
const notifications = ref<MonitorNotifications>({ ...DEFAULT_NOTIFICATIONS });
const channels = ref<Channel[]>([]);

const SEVERITY_OPTIONS: { label: string; value: MonitorNotifications['minSeverity'] }[] = [
  { label: 'Off', value: null },
  { label: 'Critical', value: 'CRITICAL' },
  { label: 'High and critical', value: 'HIGH' },
  { label: 'Medium and above', value: 'MEDIUM' },
];

const loadError = ref<string | null>(null);
const fieldError = ref<string | null>(null);
const submitError = ref<string | null>(null);
const isSubmitting = ref(false);

const schedule = computed(() =>
  scheduleChoice.value === CUSTOM ? customSchedule.value.trim() : scheduleChoice.value,
);

onMounted(async () => {
  channels.value = await listChannels().catch(() => []);
  if (!props.id) return;
  try {
    const monitor = (await listMonitors()).find((m) => m.id === props.id);
    if (!monitor) {
      loadError.value = 'Monitor not found.';
      return;
    }
    repoUrl.value = monitor.repoUrl;
    searchPath.value = monitor.searchPath ?? '';
    ref_.value = monitor.ref ?? '';
    const isPreset = SCHEDULE_PRESETS.some((p) => (p.value ?? '') === (monitor.schedule ?? ''));
    scheduleChoice.value = isPreset ? (monitor.schedule ?? '') : CUSTOM;
    customSchedule.value = isPreset ? '' : (monitor.schedule ?? '');
    notifications.value = { ...monitor.notifications };
  } catch {
    loadError.value = 'Failed to load the monitor.';
  }
});

// Live preview of when the schedule fires, from the server (its TZ is what counts)
const preview = ref<SchedulePreview | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  schedule,
  (expression) => {
    clearTimeout(previewTimer);
    if (!expression) {
      preview.value = null;
      return;
    }
    previewTimer = setTimeout(async () => {
      preview.value = await previewSchedule(expression).catch(() => null);
    }, 300);
  },
  { immediate: true },
);

async function onSubmit() {
  fieldError.value = null;
  submitError.value = null;

  const parsed = monitorInputSchema.safeParse({
    repoUrl: repoUrl.value,
    searchPath: searchPath.value,
    ref: ref_.value,
    schedule: schedule.value,
    notifications: notifications.value,
  });
  if (!parsed.success) {
    fieldError.value = parsed.error.issues[0]?.message ?? 'Invalid input';
    return;
  }
  if (preview.value && !preview.value.valid) {
    fieldError.value = `Schedule: ${preview.value.error}`;
    return;
  }

  isSubmitting.value = true;
  try {
    if (props.id) {
      await updateMonitor(props.id, parsed.data);
      await router.push('/');
    } else {
      // The first scan starts right away: show it
      const monitor = await createMonitor(parsed.data);
      await router.push(monitor.scans[0] ? `/scans/${monitor.scans[0].id}` : '/');
    }
  } catch (e) {
    submitError.value = e instanceof ApiError ? e.message : 'Saving failed.';
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <h1 class="mono title">{{ id ? 'Edit monitor' : 'New monitor' }}</h1>

  <p v-if="loadError" class="error">{{ loadError }}</p>

  <form v-else class="card" @submit.prevent="onSubmit">
    <div class="field">
      <label for="repoUrl">GitOps repo URL</label>
      <input
        id="repoUrl"
        v-model="repoUrl"
        type="text"
        placeholder="https://github.com/org/gitops-repo or git@github.com:org/gitops-repo.git"
        required
      />
      <p class="text-muted hint">
        Any public git repo works. Private repos need <code>GITHUB_TOKEN</code> or
        <code>GIT_CREDENTIALS</code> on the server.
      </p>
    </div>

    <div class="field">
      <label for="searchPath">Path in repo (optional)</label>
      <input
        id="searchPath"
        v-model="searchPath"
        type="text"
        placeholder="argocd/applicationsets"
      />
    </div>

    <div class="field">
      <label for="ref">Branch / ref (optional, defaults to the default branch)</label>
      <input id="ref" v-model="ref_" type="text" placeholder="main" />
    </div>

    <div class="field">
      <label for="schedule">Scan schedule</label>
      <select id="schedule" v-model="scheduleChoice">
        <option v-for="preset in SCHEDULE_PRESETS" :key="preset.label" :value="preset.value ?? ''">
          {{ preset.label }}
        </option>
        <option :value="CUSTOM">Custom (cron expression)…</option>
      </select>
      <input
        v-if="scheduleChoice === CUSTOM"
        v-model="customSchedule"
        class="custom"
        type="text"
        placeholder="0 */12 * * *"
        aria-label="Cron expression"
        required
      />
      <p v-if="preview && !preview.valid" class="error hint">{{ preview.error }}</p>
      <p v-else-if="preview" class="text-muted hint">
        Next runs ({{ preview.timezone }}):
        {{ preview.nextRuns.map(formatDateTime).join(' · ') }}
      </p>
      <p v-else-if="!schedule" class="text-muted hint">
        Runs only when you start it from the overview.
      </p>
    </div>

    <fieldset class="notifications">
      <legend>Notifications</legend>
      <div class="field">
        <label for="channel">Send to</label>
        <select id="channel" v-model="notifications.channelId">
          <option :value="null">Nowhere (off)</option>
          <option v-for="channel in channels" :key="channel.id" :value="channel.id">
            {{ channel.name }}
          </option>
        </select>
        <p v-if="channels.length === 0" class="text-muted hint">
          No channels yet: add a Discord or webhook channel in
          <RouterLink to="/settings">Settings</RouterLink>.
        </p>
      </div>

      <template v-if="notifications.channelId">
        <div class="field">
          <label for="severity">New vulnerabilities</label>
          <select id="severity" v-model="notifications.minSeverity">
            <option v-for="option in SEVERITY_OPTIONS" :key="option.label" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </div>
        <label class="check">
          <input
            v-model="notifications.onlyFixable"
            type="checkbox"
            :disabled="!notifications.minSeverity"
          />
          Only vulnerabilities that have a fix available
        </label>
        <label class="check">
          <input
            type="checkbox"
            :checked="notifications.chartUpdates === 'any'"
            @change="
              notifications.chartUpdates = ($event.target as HTMLInputElement).checked
                ? 'any'
                : 'off'
            "
          />
          New chart versions
        </label>
        <label class="check">
          <input v-model="notifications.onFailure" type="checkbox" />
          Failed scans
        </label>
        <p class="text-muted hint">
          The first scan sends an overview; after that only what is new since the previous scan, so
          an unchanged repo stays quiet.
        </p>
      </template>
    </fieldset>

    <p v-if="fieldError" class="error">{{ fieldError }}</p>
    <p v-if="submitError" class="error">{{ submitError }}</p>

    <div class="buttons">
      <button type="submit" class="btn-primary" :disabled="isSubmitting">
        {{ isSubmitting ? 'Saving…' : id ? 'Save' : 'Create and run first scan' }}
      </button>
      <RouterLink to="/" class="text-muted">Cancel</RouterLink>
    </div>
  </form>
</template>

<style scoped>
.title {
  margin-bottom: var(--space-6);
}
.field {
  margin-bottom: var(--space-4);
}
.hint {
  margin-top: var(--space-2);
  font-size: 0.875rem;
}
.custom {
  margin-top: var(--space-2);
}
.error {
  color: #ef4444;
  margin-bottom: var(--space-4);
}
.hint.error {
  margin-bottom: 0;
}
.notifications {
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin: var(--space-6) 0;
}
.notifications legend {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  color: var(--color-text);
  cursor: pointer;
}
.check input {
  width: auto;
}
.buttons {
  display: flex;
  align-items: center;
  gap: var(--space-6);
}
</style>
