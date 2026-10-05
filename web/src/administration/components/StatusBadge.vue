<script setup lang="ts">
import { consoleStatusLabel } from "../presentation";
defineProps<{ status: string; label?: string }>();
</script>
<template><span class="admin-status" :data-status="status">{{ label || consoleStatusLabel(status) }}</span></template>
<style scoped>
.admin-status { display: inline-flex; align-items: center; border: 1px solid #d0d5dd; border-radius: 4px; color: #344054; background: #f9fafb; padding: 2px 8px; font-size: 12px; line-height: 18px; white-space: nowrap; }
.admin-status[data-status='active'], .admin-status[data-status='enabled'], .admin-status[data-status='applied'], .admin-status[data-status='clean'] { color: #166534; background: #f0fdf4; border-color: #bbf7d0; }
.admin-status[data-status='pending'], .admin-status[data-status='approved'], .admin-status[data-status='needs_recovery'] { color: #854d0e; background: #fefce8; border-color: #fde68a; }
.admin-status[data-status='rejected'], .admin-status[data-status='failed'], .admin-status[data-status='disabled'], .admin-status[data-status='revoked'] { color: #b42318; background: #fff3f0; border-color: #fecdca; }
</style>
