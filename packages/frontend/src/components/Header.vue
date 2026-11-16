<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useTheme } from '../composables/useTheme.js';
import { getSession, logout } from '../api/client.js';

const { theme, toggle } = useTheme();

// Only shown when login is on and active (not with AUTH_DISABLED, not on the login page)
const showLogout = ref(false);
onMounted(async () => {
  const session = await getSession().catch(() => null);
  showLogout.value = Boolean(session?.authEnabled && session.authenticated);
});

async function onLogout() {
  await logout();
  window.location.assign('/login');
}
</script>

<template>
  <header class="mono">
    <div class="container">
      <RouterLink class="name" to="/">
        <span class="user">chart-monitor</span>
        <span class="at">@</span>
        <span class="domain">scipak.eu</span>
      </RouterLink>

      <nav>
        <ul>
          <li><RouterLink to="/">~/scans</RouterLink></li>
          <li><RouterLink to="/scans/new">~/new-scan</RouterLink></li>
        </ul>
      </nav>

      <div class="actions">
        <button class="icon-button" aria-label="Toggle theme" @click="toggle">
          <Icon v-if="theme === 'light'" icon="lucide:moon" />
          <Icon v-else icon="lucide:sun" />
        </button>
        <button v-if="showLogout" class="icon-button" aria-label="Log out" title="Log out" @click="onLogout">
          <Icon icon="lucide:log-out" />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
header {
  background-color: var(--color-bg-elevated);
  border-bottom: 1px solid var(--color-border-subtle);
}

header .container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-4);
}

nav ul {
  list-style: none;
  display: flex;
  gap: var(--space-6);
}

nav a {
  color: var(--color-text-muted);
  font-weight: 500;
}

nav a:hover {
  color: var(--color-primary);
}

.actions {
  display: flex;
  gap: var(--space-4);
}

.icon-button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  font-size: 1.25rem;
  transition: color var(--transition);
}

.icon-button:hover {
  color: var(--color-primary);
}

.name {
  font-weight: 500;
}
.user {
  color: var(--color-text);
}
.at {
  color: var(--color-text-disabled);
}
.domain {
  color: var(--color-primary);
}
</style>
