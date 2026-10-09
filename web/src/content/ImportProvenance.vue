<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import type { BusinessRequest } from "../session";
type Proof = {
  id: string;
  file_id: string;
  applied_revision: number;
  chapter_ids: string[];
  license: { source: string; granted: boolean; expires_at: string | null };
  rights_type: string;
  proof_reference: string;
  usage_restrictions: string;
  created_at: string;
};
const props = defineProps<{ request: BusinessRequest; ownerId: string }>();
const rows = ref<Proof[]>([]),
  message = ref(""),
  busy = ref(false);
const lifetime = new AbortController();
let alive = true,
  timer = 0;
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await props.request<{ items: Proof[]; truncated: boolean }>(
      "/admin/textbook-editions/" + props.ownerId + "/imports/provenance",
      { signal: lifetime.signal },
    );
    if (!alive) return;
    rows.value = result.items;
    message.value = result.truncated
      ? "仅展示最近50条来源证明。"
      : rows.value.length
        ? "记录应用当时的版本和来源，后续编辑可能已替换原章节。"
        : "此版本暂无导入来源证明。";
  } catch (e) {
    if (alive) {
      rows.value = [];
      message.value = e instanceof Error ? e.message : "来源证明读取失败";
    }
  } finally {
    if (alive) busy.value = false;
  }
}
onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    void load();
  }, 15000);
});
onBeforeUnmount(() => {
  alive = false;
  window.clearInterval(timer);
  lifetime.abort();
  rows.value = [];
});
</script>
<template>
  <section class="content-section stack">
    <h3>导入来源与授权证明</h3>
    <p role="status">{{ message }}</p>
    <button class="button secondary" :disabled="busy" @click="load">
      重新核查当前授权下的证明
    </button>
    <details v-for="row in rows" :key="row.id">
      <summary>
        应用版本 {{ row.applied_revision }} · {{ row.created_at }}
      </summary>
      <dl>
        <dt>来源许可</dt>
        <dd>{{ row.license.source }}</dd>
        <dt>权利类型</dt>
        <dd>
          {{
            {
              original: "原创",
              authorized: "已获授权",
              "public-domain": "公有领域",
            }[row.rights_type as "original"] || row.rights_type
          }}
        </dd>
        <dt>授权证明引用</dt>
        <dd>{{ row.proof_reference }}</dd>
        <dt>有效期</dt>
        <dd>{{ row.license.expires_at || "未指定" }}</dd>
        <dt>用途限制</dt>
        <dd>{{ row.usage_restrictions || "未填写" }}</dd>
        <dt>来源文件</dt>
        <dd>{{ row.file_id }}</dd>
        <dt>应用当时章节数</dt>
        <dd>{{ row.chapter_ids.length }}</dd>
      </dl>
    </details>
  </section>
</template>
<style scoped>
dd,
summary {
  overflow-wrap: anywhere;
}
dd {
  margin-inline-start: 1rem;
}
</style>
