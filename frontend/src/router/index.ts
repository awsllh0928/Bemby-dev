import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/:pathMatch(.*)*', component: {}, meta: { appShell: true } },
  ],
});

router.beforeEach((to, _from, next) => {
  const isPublic = to.meta.public === true;
  const hasToken = Boolean(localStorage.getItem('token'));

  if (!isPublic && !hasToken) {
    next('/login');
  } else if (isPublic && hasToken) {
    next('/');
  } else {
    next();
  }
});

export default router;
