<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('nav.schedule') }}</h2>
    </div>
    <div class="card" style="padding: 16px 18px">
      <ScheduleList />
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n';
import ScheduleList from '../components/ScheduleList.vue';
</script>
