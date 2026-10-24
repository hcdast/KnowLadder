<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const route = useRoute();
let overflow = "",
  scrollY = 0;
onMounted(async () => {
  overflow = document.documentElement.style.overflow;
  scrollY = window.scrollY;
  document.documentElement.style.overflow = "hidden";
  dialog.value?.showModal();
  await nextTick();
  dialog.value
    ?.querySelector<HTMLElement>("input:not([disabled]), h1")
    ?.focus();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.documentElement.style.overflow = overflow;
  window.scrollTo({
    top: route.meta.category === "public" ? scrollY : 0,
    behavior: "instant",
  });
});
function trap(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), summary",
    ) || [],
  ).filter(
    (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      (!element.closest("details:not([open])") ||
        element.tagName === "SUMMARY"),
  );
  const first = controls[0],
    last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>
<template>
  <dialog
    ref="dialog"
    class="login-dialog"
    aria-labelledby="modal-login-title"
    @cancel.prevent="emit('close')"
    @keydown="trap"
  >
    <button class="dialog-close" aria-label="关闭登录" @click="emit('close')">
      ×
    </button>
    <header class="dialog-heading">
      <img src="/visuals/logo.svg" width="36" height="36" alt="" />
      <div>
        <h1 id="modal-login-title" tabindex="-1">登录知阶</h1>
        <p class="dialog-intro">继续你的学习与教学</p>
      </div>
    </header>
    <slot />
  </dialog>
</template>
<style scoped>
.login-dialog {
  width: min(420px, calc(100vw - 40px));
  max-height: calc(100svh - 48px);
  overflow: auto;
  border: 1px solid #dae5ee;
  border-radius: 20px;
  padding: 28px;
  background: white;
  color: #20384a;
  box-shadow: 0 24px 100px #132c4950;
}
.login-dialog::backdrop {
  background: #10283e66;
  backdrop-filter: blur(2px);
}
.dialog-close {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #425a6c;
  cursor: pointer;
  font-size: 25px;
}
.dialog-close:focus-visible {
  outline: 3px solid #9ccaf5;
}
.dialog-close:hover {
  background: #f2f6fa;
}
.dialog-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-right: 22px;
  margin-bottom: 26px;
}
.login-dialog h1 {
  font-size: 23px;
  margin: 0 0 4px;
}
.dialog-intro {
  color: #63798a;
  font-size: 13px;
  margin: 0;
}
</style>
