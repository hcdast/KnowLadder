<script setup lang="ts">
defineOptions({ inheritAttrs: false });
defineProps<{ error?: Error }>();

// Vue forwards the workspace ref to its loading component before the module resolves.
// This state has no editable inputs or business operation to leave behind.
defineExpose({ beforeLeave: async () => true });

function reload() {
  if (window.confirm("将重新加载当前页面，尚未保存的输入会丢失。确定重新加载？")) {
    window.location.reload();
  }
}
</script>

<template>
  <section
    class="panel stack"
    :role="error ? 'alert' : 'status'"
    :aria-busy="!error"
    aria-label="页面模块加载状态"
  >
    <template v-if="error">
      <h2>页面模块加载未完成</h2>
      <p>可能是网络连接中断、加载超时或页面版本已更新。当前功能尚未就绪，不代表任何业务操作成功。</p>
      <p>不会自动重试或重新提交操作。请检查连接后明确重新加载页面；尚未保存的输入会丢失。</p>
      <div class="actions">
        <button type="button" class="button secondary" @click="reload">重新加载页面</button>
      </div>
    </template>
    <template v-else>
      <h2>正在加载页面模块</h2>
      <p>模块就绪后再显示功能与数据，请稍候。</p>
    </template>
  </section>
</template>
