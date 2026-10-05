<script setup lang="ts">
defineProps<{ name: 'book-open' | 'graduation-cap' | 'chart-no-axes-combined' | 'shield-check' | 'arrow-right' | 'notebook-pen' }>();
</script>

<template>
  <span class="brand-icon" aria-hidden="true" :style="{ '--icon-source': `url(/visuals/icons/${name}.svg)` }" />
</template>

<style scoped>
.brand-icon { display: inline-block; width: 1.25em; height: 1.25em; flex: 0 0 1.25em; vertical-align: -.2em; background: currentColor; mask: var(--icon-source) center / contain no-repeat; }
</style>
