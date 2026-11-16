<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { ApiError, login } from '../api/client.js';

const route = useRoute();
const password = ref('');
const error = ref<string | null>(null);
const isSubmitting = ref(false);

// Only same-site paths, so a crafted ?redirect= link can't send the user to another website
function redirectTarget(): string {
  const target = route.query.redirect;
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')
    ? target
    : '/';
}

async function onSubmit() {
  error.value = null;
  isSubmitting.value = true;
  try {
    if (await login(password.value)) {
      // Full navigation, so every view and the header start fresh with the new session
      window.location.assign(redirectTarget());
    } else {
      error.value = 'Wrong password.';
      password.value = '';
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'Login failed.';
  } finally {
    isSubmitting.value = false;
  }
}
</script>

<template>
  <form class="card login" @submit.prevent="onSubmit">
    <h1 class="mono">Log in</h1>
    <div class="field">
      <label for="password">Password</label>
      <input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
      />
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="submit" class="btn-primary" :disabled="isSubmitting || !password">
      {{ isSubmitting ? 'Logging in…' : 'Log in' }}
    </button>
  </form>
</template>

<style scoped>
.login {
  max-width: 24rem;
  margin: var(--space-6) auto;
}
.login h1 {
  margin-bottom: var(--space-6);
}
.field {
  margin-bottom: var(--space-4);
}
.error {
  color: #ef4444;
  margin-bottom: var(--space-4);
}
</style>
