import { createApp } from 'vue';
import { addCollection } from '@iconify/vue';
import lucideIcons from '@iconify-json/lucide/icons.json';
import App from './App.vue';
import router from './router/index.js';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './assets/css/main.css';

// Registers Lucide icons from the locally installed data instead of @iconify/vue's default
// behaviour of fetching each icon from the public Iconify API at runtime.
addCollection(lucideIcons);

createApp(App).use(router).mount('#app');
