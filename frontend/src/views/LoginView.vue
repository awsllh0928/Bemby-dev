<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">Bemby</h1>
      <p class="login-subtitle">{{ t('login.subtitle') }}</p>

      <div v-if="error" class="error-msg">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="form-group">
          <label class="form-label">{{ t('login.username') }}</label>
          <input v-model="form.username" class="form-input" type="text" autocomplete="username" required />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('login.password') }}</label>
          <input v-model="form.password" class="form-input" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" :disabled="loading" type="submit">
          {{ loading ? t('login.signingIn') : t('login.signIn') }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { authApi, requirePasswordChangeSignal } from '../api/client';
import { t } from '../i18n';

const router = useRouter();
const form = reactive({ username: '', password: '' });
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const { token, requirePasswordChange } = await authApi.login(form.username, form.password);
    localStorage.setItem('token', token);
    if (requirePasswordChange) {
      localStorage.setItem('bemby:requirePasswordChange', '1');
      requirePasswordChangeSignal.value = true;
    }
    router.push('/');
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;

    if (status === 429) {
      error.value = t('login.rateLimited');
    } else {
      error.value = t('login.error');
    }
  } finally {
    loading.value = false;
  }
}
</script>
