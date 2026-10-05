<script setup lang="ts">
import { ref } from 'vue';
import BrandIcon from './BrandIcon.vue';
const imageFailed = ref(false);
</script>

<template>
  <aside class="intro brand-journey" aria-label="知阶介绍">
    <p class="eyebrow">知阶而上 · 智达未来</p>
    <h2>每一步，<br /><span>都算数。</span></h2>
    <p class="journey-description">从一页课本，到一次新的理解。<br />在知阶，找到属于自己的学习节奏。</p>
    <div class="journey-picture" :class="{ 'image-unavailable': imageFailed }">
      <picture v-if="!imageFailed">
        <source media="(max-width: 48rem)" srcset="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
        <img src="/visuals/study-desk.webp" alt="" width="1080" height="720" decoding="async" @error="imageFailed = true" />
      </picture>
      <div class="journey-caption"><BrandIcon name="book-open" /><span>让知识，成为向上的阶梯</span></div>
    </div>
    <ul class="journey-steps" aria-label="学习过程">
      <li><span class="journey-step-icon"><BrandIcon name="book-open" /></span><span>读懂新知</span></li>
      <li><span class="journey-step-icon"><BrandIcon name="notebook-pen" /></span><span>练习巩固</span></li>
      <li><span class="journey-step-icon"><BrandIcon name="chart-no-axes-combined" /></span><span>回顾成长</span></li>
    </ul>
  </aside>
</template>
