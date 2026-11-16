import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
    { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
    {
      path: '/monitors/new',
      name: 'new-monitor',
      component: () => import('../views/MonitorFormView.vue'),
    },
    {
      path: '/monitors/:id/edit',
      name: 'edit-monitor',
      component: () => import('../views/MonitorFormView.vue'),
      props: true,
    },
    {
      path: '/scans/:id',
      name: 'scan-detail',
      component: () => import('../views/ScanDetailView.vue'),
      props: true,
    },
  ],
});

export default router;
