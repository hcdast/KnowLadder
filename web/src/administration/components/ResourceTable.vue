<script setup lang="ts">
withDefaults(defineProps<{ headers: string[]; busy?: boolean; empty?: boolean; emptyLabel?: string }>(), { emptyLabel: "暂无记录" });
</script>
<template>
  <div class="admin-table-scroll" role="region" aria-label="资源表格，可横向滚动" tabindex="0" :aria-busy="busy">
    <table class="admin-table"><thead><tr><th v-for="(header, index) in headers" :key="index" scope="col">{{ header }}</th></tr></thead>
      <tbody><tr v-if="busy"><td :colspan="headers.length" class="admin-empty" role="status">正在读取…</td></tr>
        <tr v-else-if="empty"><td :colspan="headers.length" class="admin-empty">{{ emptyLabel }}</td></tr>
        <slot v-else />
      </tbody>
    </table>
  </div>
</template>
<style scoped>
.admin-table-scroll { overflow-x: auto; width: 100%; min-width: 0; border: 1px solid var(--color-border); border-radius: 6px; }
.admin-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; line-height: 22px; }
.admin-table th { background: #f9fafb; color: var(--color-muted); font-size: 14px; font-weight: 500; white-space: nowrap; }
.admin-table th, .admin-table :deep(td) { padding: 12px 16px; border-bottom: 1px solid var(--color-border); vertical-align: top; min-height: 48px; }
.admin-table :deep(tr:last-child td) { border-bottom: 0; }
.admin-table :deep(td:last-child) { white-space: nowrap; }
.admin-table :deep(td) { min-width: 100px; }
.admin-table tbody :deep(tr:hover) { background: #f9fafb; }
.admin-table .admin-empty { text-align: center; color: var(--color-muted); padding: 32px 16px !important; }
@media (max-width: 639px) {
  .admin-table th, .admin-table :deep(td) { padding: 10px 12px; }
}
</style>
