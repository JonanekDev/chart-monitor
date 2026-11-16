import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // Dev only: the API runs separately (`pnpm dev` starts both); in production the backend serves
    // the built UI itself, so the browser always talks to one origin
    proxy: { '/api': 'http://localhost:3000' },
  },
});
