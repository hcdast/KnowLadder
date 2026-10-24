<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import SiteImage from "./SiteImage.vue";
import { localMediaFallback, mediaURL, mediaVideos } from "./media";
const props = withDefaults(defineProps<{ kind?: keyof typeof mediaVideos }>(), {
  kind: "tour",
});
const entry = computed(() => mediaVideos[props.kind]);
const sectionId = computed(() =>
  props.kind === "tour" ? "tour" : props.kind + "-film",
);
const poster = computed(() => mediaURL(entry.value.base + "-poster.webp"));
const local = ref(false),
  requested = ref(false),
  failed = ref(false);
const captionsLocal = ref(false);
const remoteMovie = computed(() => mediaURL(entry.value.base + ".mp4"));
const movie = computed(() =>
  local.value ? localMediaFallback(remoteMovie.value)! : remoteMovie.value,
);
const captions = computed(
  () =>
    (captionsLocal.value ? "/website/" : "http://cdn.zhihexu.cn/knowladder/") +
    entry.value.base +
    ".zh.vtt",
);
const transcript = computed(() =>
  mediaURL(entry.value.base + "-transcript-zh.txt"),
);
const video = ref<HTMLVideoElement>(),
  errorNote = ref<HTMLElement>();
watch(
  () => props.kind,
  () => {
    video.value?.pause();
    requested.value = false;
    failed.value = false;
    local.value = false;
    captionsLocal.value = false;
  },
);
watch(failed, async (value) => {
  if (value) {
    await nextTick();
    errorNote.value?.focus();
  }
});
async function start() {
  requested.value = true;
  await nextTick();
  video.value?.focus();
  try {
    await video.value?.play();
  } catch {
    /* Keep native controls. */
  }
}
async function playbackError() {
  if (!local.value) {
    local.value = true;
    captionsLocal.value = true;
    await nextTick();
    video.value?.load();
    try {
      await video.value?.play();
    } catch {
      /* Keep native controls. */
    }
  } else failed.value = true;
}
onBeforeUnmount(() => video.value?.pause());
</script>
<template>
  <section
    :id="sectionId"
    class="product-tour"
    :aria-labelledby="sectionId + '-title'"
  >
    <div class="tour-heading">
      <div>
        <p class="tour-eyebrow">{{ entry.eyebrow }}</p>
        <h2 :id="sectionId + '-title'">{{ entry.title }}</h2>
      </div>
      <p>点击播放，随时暂停。<br />按自己的节奏了解知阶。</p>
    </div>
    <figure>
      <video
        v-if="requested && !failed"
        ref="video"
        :src="movie"
        controls
        playsinline
        preload="none"
        crossorigin="anonymous"
        :poster="poster"
        :aria-label="entry.eyebrow + '，无配音'"
        :aria-describedby="sectionId + '-caption'"
        tabindex="0"
        @error="playbackError"
      >
        <track
          v-if="kind !== 'ai'"
          kind="captions"
          :src="captions"
          srclang="zh"
          label="中文说明"
          @error="captionsLocal = true"
        />
      </video>
      <div v-else class="tour-preview">
        <SiteImage
          :src="poster"
          :alt="entry.title"
          :width="1920"
          :height="1080"
        />
        <button v-if="!failed" type="button" class="tour-play" @click="start">
          <span aria-hidden="true">▶</span> 播放 {{ entry.duration }} 秒{{
            kind === "tour" ? "导览" : kind === "brand" ? "短片" : "动效"
          }}
        </button>
        <p
          v-else
          ref="errorNote"
          class="tour-error"
          role="status"
          tabindex="-1"
        >
          视频暂时无法播放，请阅读下方文字或<RouterLink to="/features"
            >查看产品功能</RouterLink
          >。
        </p>
      </div>
      <figcaption :id="sectionId + '-caption'">{{ entry.caption }}</figcaption>
    </figure>
    <details class="tour-transcript">
      <summary>阅读{{ kind === "tour" ? "导览" : "短片" }}文字</summary>
      <ol>
        <li v-for="step in entry.steps" :key="step">{{ step }}</li>
      </ol>
      <a :href="transcript" target="_blank" rel="noopener">查看完整文字稿 ↗</a>
      <p v-if="kind === 'tour'">可用功能以账号授权与配置为准。</p>
    </details>
  </section>
</template>
<style scoped>
.product-tour {
  max-width: 1280px;
  margin: auto;
  padding: 0 40px 72px;
  scroll-margin-top: 24px;
}
.tour-heading {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 30px;
  margin-bottom: 28px;
}
.tour-eyebrow {
  color: #087f78;
  font-size: 12px;
  font-weight: 600;
}
h2 {
  font-size: 30px;
  line-height: 1.5;
  margin: 9px 0 12px;
  color: #19354b;
}
.tour-heading > p {
  color: #62798b;
  font-size: 14px;
  line-height: 1.85;
}
figure {
  margin: 0;
  border: 1px solid #d9e4ed;
  border-radius: 16px;
  overflow: hidden;
  background: #f4f8fc;
}
video,
img {
  display: block;
  width: 100%;
  aspect-ratio: 16/9;
  height: auto;
}
.tour-preview {
  position: relative;
  aspect-ratio: 16/9;
}
.tour-play {
  position: absolute;
  left: 50%;
  bottom: 12%;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: 48px;
  padding: 14px 22px;
  border: 0;
  border-radius: 10px;
  background: #1263b0;
  color: white;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: 0 6px 24px #12395424;
}
button:focus-visible,
summary:focus-visible,
video:focus-visible {
  outline: 3px solid #1263b0;
  outline-offset: 4px;
}
.tour-error {
  padding: 18px 24px;
  margin: 0;
  line-height: 1.8;
}
.tour-without-poster .tour-play {
  position: static;
  transform: none;
  margin: 16px auto;
}
a {
  color: #1263b0;
}
figcaption {
  text-align: center;
  padding: 12px;
  font-size: 12px;
  color: #63798a;
  background: white;
}
.tour-transcript {
  margin-top: 18px;
  color: #536b7d;
  font-size: 14px;
  line-height: 1.85;
}
summary {
  width: fit-content;
  padding: 10px 0;
  color: #1263b0;
  cursor: pointer;
}
li {
  margin-bottom: 8px;
}
@media (max-width: 800px) {
  .product-tour {
    padding: 0 24px 56px;
  }
  .tour-heading {
    display: block;
  }
  h2 {
    font-size: 26px;
  }
  .tour-play {
    position: static;
    transform: none;
    margin: 16px auto;
  }
}
@media (max-width: 420px) {
  .product-tour {
    padding: 0 20px 40px;
  }
  h2 {
    font-size: 24px;
  }
  .tour-play {
    padding: 10px 16px;
    font-size: 13px;
    bottom: 9%;
  }
}
</style>
