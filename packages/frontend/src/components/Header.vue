<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useTheme } from '../composables/useTheme.js';

const { theme, toggle } = useTheme();
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

      <button class="theme-switch" aria-label="Toggle theme" @click="toggle">
        <Icon v-if="theme === 'light'" icon="lucide:moon" />
        <Icon v-else icon="lucide:sun" />
      </button>
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

.theme-switch {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  font-size: 1.25rem;
  transition: color var(--transition);
}

.theme-switch:hover {
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
