<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title: string;
    confirmText?: string;
    cancelText?: string;
  }>(),
  { confirmText: "确认", cancelText: "取消" },
);
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [];
  cancel: [];
}>();
const dialog = ref<HTMLDialogElement>();
const safeButton = ref<HTMLButtonElement>();
const titleId = useId();
let previousFocus: HTMLElement | null = null;
function close(confirmed = false) {
  emit("update:modelValue", false);
  if (confirmed) emit("confirm");
  else emit("cancel");
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== "Tab" || !dialog.value) return;
  const items = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
  const first = items[0],
    last = items[items.length - 1];
  if (!first) {
    event.preventDefault();
    dialog.value.focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
watch(
  () => props.modelValue,
  async (open) => {
    await nextTick();
    if (open && dialog.value && !dialog.value.open) {
      previousFocus = document.activeElement as HTMLElement;
      dialog.value.showModal();
      safeButton.value?.focus();
    } else if (!open && dialog.value?.open) {
      dialog.value.close();
      previousFocus?.focus();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  dialog.value?.close();
});
</script>
<template>
  <dialog
    ref="dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="close(false)"
    @keydown="trapFocus"
  >
    <div class="dialog-body">
      <h2 :id="titleId">{{ title }}</h2>
      <slot />
      <div class="actions dialog-actions">
        <button
          ref="safeButton"
          class="button secondary"
          type="button"
          @click="close(false)"
        >
          {{ cancelText }}</button
        ><button class="button" type="button" @click="close(true)">
          {{ confirmText }}
        </button>
      </div>
    </div>
  </dialog>
</template>
