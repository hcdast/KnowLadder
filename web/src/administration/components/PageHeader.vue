<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <header class="admin-page-header">
    <div><h1>{{ title }}</h1><p v-if="description" class="admin-meta">{{ description }}</p><slot /></div>
    <div v-if="$slots.actions" class="actions admin-page-actions"><slot name="actions" /></div>
  </header>
</template>
<style scoped>
.admin-page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.admin-page-header p { margin-top: 8px; }
.admin-page-actions { flex-shrink: 0; }
@media (max-width: 639px) {
  .admin-page-header { flex-wrap: wrap; }
  .admin-page-actions { width: 100%; }
}
</style>
