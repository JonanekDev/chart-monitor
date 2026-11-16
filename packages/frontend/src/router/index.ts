import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue') },
    { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
    { path: '/scans/new', name: 'new-scan', component: () => import('../views/NewScanView.vue') },
    {
      path: '/scans/:id',
      name: 'scan-detail',
      component: () => import('../views/ScanDetailView.vue'),
      props: true,
    },
  ],
});

export default router;
