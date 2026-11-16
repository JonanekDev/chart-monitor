<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { channelInputSchema, type Channel, type ChannelTypeValue } from '@chart-monitor/shared';
import {
  ApiError,
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
} from '../api/client.js';

const channels = ref<Channel[]>([]);
const loadError = ref<string | null>(null);
// Per-channel result of the last action, shown next to it
const status = ref(new Map<string, { ok: boolean; text: string }>());
const busy = ref(new Set<string>());

const name = ref('');
const type = ref<ChannelTypeValue>('discord');
const url = ref('');
const formError = ref<string | null>(null);
const isSaving = ref(false);

const TYPE_LABEL: Record<ChannelTypeValue, string> = {
  discord: 'Discord',
  webhook: 'Webhook (JSON)',
};

async function refresh() {
  try {
    channels.value = await listChannels();
  } catch {
    loadError.value = 'Failed to load channels.';
  }
}
onMounted(refresh);

async function onAdd() {
  formError.value = null;
  const parsed = channelInputSchema.safeParse({
    name: name.value,
    type: type.value,
    url: url.value,
  });
  if (!parsed.success) {
    formError.value = parsed.error.issues[0]?.message ?? 'Invalid input';
    return;
  }
  isSaving.value = true;
  try {
    const channel = await createChannel(parsed.data);
    name.value = '';
    url.value = '';
    await refresh();
    await onTest(channel); // so a wrong URL shows up right away
  } catch (e) {
    formError.value = e instanceof ApiError ? e.message : 'Saving failed.';
  } finally {
    isSaving.value = false;
  }
}

async function onTest(channel: Channel) {
  busy.value.add(channel.id);
  try {
    await testChannel(channel.id);
    status.value.set(channel.id, { ok: true, text: 'Test message sent' });
  } catch (e) {
    status.value.set(channel.id, {
      ok: false,
      text: e instanceof ApiError ? e.message : 'Sending failed',
    });
  } finally {
    busy.value.delete(channel.id);
  }
}

async function onDelete(channel: Channel) {
  if (!window.confirm(`Delete channel "${channel.name}"? Monitors using it stop notifying.`))
    return;
  busy.value.add(channel.id);
  try {
    await deleteChannel(channel.id);
    await refresh();
  } finally {
    busy.value.delete(channel.id);
  }
}
</script>

<template>
  <h1 class="mono title">Settings</h1>

  <section class="card section">
    <h2 class="mono">Notification channels</h2>
    <p class="text-muted intro">
      Where monitors send their notifications. Each monitor picks a channel and its own rules
      (severity, chart updates…) in its settings.
    </p>

    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-else-if="channels.length === 0" class="text-muted">No channels yet.</p>
    <ul v-else class="channels">
      <li v-for="channel in channels" :key="channel.id" class="channel">
        <div>
          <strong>{{ channel.name }}</strong>
          <span class="text-muted"> · {{ TYPE_LABEL[channel.type] }} · </span>
          <span class="text-muted mono">{{ channel.urlPreview }}</span>
          <p
            v-if="status.get(channel.id)"
            :class="['result', status.get(channel.id)!.ok ? 'ok' : 'error']"
            role="status"
          >
            {{ status.get(channel.id)!.text }}
          </p>
        </div>
        <div class="actions">
          <button
            class="btn-icon"
            :disabled="busy.has(channel.id)"
            :aria-label="`Send a test message to ${channel.name}`"
            title="Send test message"
            @click="onTest(channel)"
          >
            <Icon icon="lucide:send" />
          </button>
          <button
            class="btn-icon danger"
            :disabled="busy.has(channel.id)"
            :aria-label="`Delete ${channel.name}`"
            title="Delete"
            @click="onDelete(channel)"
          >
            <Icon icon="lucide:trash-2" />
          </button>
        </div>
      </li>
    </ul>

    <form class="add" @submit.prevent="onAdd">
      <h3>Add a channel</h3>
      <div class="row">
        <div class="field">
          <label for="channel-name">Name</label>
          <input id="channel-name" v-model="name" type="text" placeholder="#alerts" required />
        </div>
        <div class="field">
          <label for="channel-type">Type</label>
          <select id="channel-type" v-model="type">
            <option v-for="(label, value) in TYPE_LABEL" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </div>
      </div>
      <div class="field">
        <label for="channel-url">Webhook URL</label>
        <input
          id="channel-url"
          v-model="url"
          type="url"
          autocomplete="off"
          :placeholder="
            type === 'discord'
              ? 'https://discord.com/api/webhooks/…'
              : 'https://ntfy.example.com/topic, n8n, …'
          "
          required
        />
        <p class="text-muted hint">
          <template v-if="type === 'discord'">
            Discord: channel settings → Integrations → Webhooks → New webhook → Copy URL.
          </template>
          <template v-else
            >Receives a JSON POST with the findings and a plain-text summary.</template
          >
          The URL is a secret, so it is not shown again after saving.
        </p>
      </div>
      <p v-if="formError" class="error">{{ formError }}</p>
      <button type="submit" class="btn-primary" :disabled="isSaving">
        {{ isSaving ? 'Saving…' : 'Add and send test' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.title {
  margin-bottom: var(--space-6);
}
.section h2 {
  margin-bottom: var(--space-2);
}
.intro {
  margin-bottom: var(--space-4);
}
.channels {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-6);
}
.channel {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-border-subtle);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}
.result {
  margin-top: var(--space-1);
  font-size: 0.875rem;
}
.ok {
  color: var(--color-primary);
}
.error {
  color: #ef4444;
  margin-bottom: var(--space-4);
}
.result.error {
  margin-bottom: 0;
}
.add h3 {
  margin-bottom: var(--space-4);
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--space-4);
}
.field {
  margin-bottom: var(--space-4);
}
.hint {
  margin-top: var(--space-2);
  font-size: 0.875rem;
}
</style>
