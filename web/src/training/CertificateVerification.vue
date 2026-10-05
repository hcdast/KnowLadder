<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useRoute, RouterLink } from "vue-router";
const route = useRoute(),
  token = ref(String(route.query.token ?? "")),
  result = ref<{
    status: string;
    organization?: string;
    course?: string;
    issued_at?: string;
  } | null>(null),
  busy = ref(false),
  message = ref("");
const controller = new AbortController();
const labels: Record<string, string> = {
  valid: "证书当前有效",
  revoked: "证书已撤销",
  pending_review: "证书来源已变化，需重新审核",
  not_found: "未找到此证书",
};
async function verify() {
  if (busy.value) return;
  result.value = null;
  message.value = "";
  if (!/^[a-f0-9]{64}$/.test(token.value.trim())) {
    message.value = "请输入完整的证书验证令牌";
    return;
  }
  busy.value = true;
  try {
    const response = await fetch(
      "/api/v1/training-public/verification/" + token.value.trim(),
      {
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      },
    );
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error?.message ?? "证书验证暂不可用");
    result.value = body.data;
  } catch (error) {
    if (!controller.signal.aborted)
      message.value = error instanceof Error ? error.message : "证书验证失败";
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  document.title = "证书验真 | 知阶 KnowLadder";
  if (token.value) void verify();
});
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <main id="main-content" tabindex="-1" class="workspace">
    <section class="panel" aria-label="证书公开验真">
      <RouterLink to="/">返回知阶首页</RouterLink>
      <h1>结业证书验真</h1>
      <p>核对当前有效来源；公开页面只展示机构、课程、签发时间与验证状态。</p>
      <form @submit.prevent="verify">
        <label
          >证书验证令牌<input
            v-model="token"
            required
            maxlength="64"
            autocomplete="off"
            spellcheck="false"
            style="width: 100%; max-width: 40rem" /></label
        ><button class="button" :disabled="busy">
          {{ busy ? "核验中…" : "验证证书" }}
        </button>
      </form>
      <p v-if="message" role="alert">{{ message }}</p>
      <div v-if="result" class="notice" role="status">
        <h2>{{ labels[result.status] }}</h2>
        <dl v-if="result.status === 'valid'">
          <dt>签发机构</dt>
          <dd>{{ result.organization }}</dd>
          <dt>课程/路径</dt>
          <dd>{{ result.course }}</dd>
          <dt>签发时间</dt>
          <dd>{{ new Date(result.issued_at!).toLocaleString() }}</dd>
        </dl>
      </div>
    </section>
  </main>
</template>
