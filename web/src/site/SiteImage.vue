<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { localMediaFallback } from "./media";
const props = withDefaults(
  defineProps<{
    src: string;
    alt: string;
    mobileSrc?: string;
    width?: number;
    height?: number;
    priority?: boolean;
  }>(),
  { width: 1600, height: 1200 },
);
const failed = ref(false),
  local = ref(false);
const current = computed(() =>
  local.value ? localMediaFallback(props.src) || props.src : props.src,
);
watch(
  () => props.src,
  () => {
    failed.value = false;
    local.value = false;
  },
);
function fallback() {
  if (!local.value && localMediaFallback(props.src)) local.value = true;
  else failed.value = true;
}
</script>
<template>
  <picture v-if="!failed" class="site-image">
    <source
      v-if="mobileSrc && !local"
      media="(max-width: 600px)"
      :srcset="mobileSrc"
      width="1200"
      height="1500"
    />
    <img
      :src="current"
      :alt="alt"
      :width="width"
      :height="height"
      :loading="priority ? 'eager' : 'lazy'"
      :fetchpriority="priority ? 'high' : 'auto'"
      decoding="async"
      @error="fallback"
    />
  </picture>
  <div v-else class="site-image-fallback" role="img" :aria-label="alt">
    {{ alt }}
  </div>
</template>
<style scoped>
.site-image {
  display: block;
  width: 100%;
  overflow: hidden;
}
img {
  display: block;
  width: 100%;
  height: auto;
}
.site-image-fallback {
  padding: 1.5rem;
  background: #f3f7fa;
  color: #445b70;
  line-height: 1.7;
}
</style>
