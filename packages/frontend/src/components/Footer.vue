<script setup lang="ts">
import { Icon } from '@iconify/vue';
</script>

<template>
  <footer>
    <div class="container">
      <p class="text-muted">
        &copy; {{ new Date().getFullYear() }}
        <a href="https://scipak.eu" target="_blank" rel="noopener">Jonáš Ščipák</a>. Built with Vue
        and Fastify with ❤️.
      </p>
      <div class="socials">
        <a href="mailto:jonas@scipak.eu" aria-label="Email">
          <Icon icon="lucide:mail" class="icon" />
        </a>
        <a href="https://github.com/JonanekDev/" target="_blank" rel="noopener" aria-label="GitHub">
          <Icon icon="lucide:github" class="icon" />
        </a>
      </div>
    </div>
  </footer>
</template>

<style scoped>
footer {
  background-color: var(--color-bg-elevated);
  padding: var(--space-8) var(--space-4);
  margin-top: auto;
  border-top: 1px solid var(--color-border-subtle);
}
.container {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.socials {
  display: flex;
  gap: var(--space-4);
}
.icon {
  width: 22px;
  height: 22px;
  color: var(--color-text-muted);
  transition: color var(--transition);
}
.icon:hover {
  color: var(--color-primary);
}
</style>
