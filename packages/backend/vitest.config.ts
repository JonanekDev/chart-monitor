import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Modules that import config/env require login settings; tests don't need a password
  test: { env: { AUTH_DISABLED: 'true' } },
});
