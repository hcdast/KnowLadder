<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ApiError, type GlobalRequest } from "../session";
import type { components } from "../api/schema";
type S = components["schemas"];
const props = defineProps<{
  orgId: string;
  userId: string;
  request: GlobalRequest;
  locked: boolean;
  write: (
    path: string,
    body: unknown,
  ) => Promise<S["LifelongOperation"] | undefined>;
}>();
const emit = defineEmits<{ dirty: [value: boolean] }>();
type Decision = "approved" | "rejected" | "revoked";
const pendingReview = ref<{
  item: S["LifelongAssuranceReview"];
  decision: Decision;
}>();
const members = ref<S["LifelongParticipant"][]>([]),
  memberCursor = ref<string | null>(null);
const records = ref<S["LifelongAssuranceReview"][]>([]),
  cursor = ref<string | null>(null),
  loading = ref(false),
  error = ref("");
const form = reactive({
  user_id: "",
  guardian_user_id: "",
  evidence_reference: "",
  policy_version: "",
  transition_at: "",
  expires_at: "",
  acknowledged: false,
});
const participants = computed(() =>
  members.value.filter((m) => m.user_id !== props.userId),
);
const life = new AbortController();
let alive = true;
async function load(more = false, people = false) {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const kind = people ? "participants" : "assurances",
      next = more ? (people ? memberCursor.value : cursor.value) : null;
    const result = await props.request<
      S["LifelongAssuranceReviewPage"] | S["LifelongParticipantPage"]
    >(
      `/personal/institutions/${props.orgId}/${kind}?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
      { signal: life.signal },
    );
    if (!alive) return;
    if (people) {
      const p = result as S["LifelongParticipantPage"];
      members.value = more ? [...members.value, ...p.items] : p.items;
      memberCursor.value = p.next_cursor;
    } else {
      const p = result as S["LifelongAssuranceReviewPage"];
      records.value = more ? [...records.value, ...p.items] : p.items;
      cursor.value = p.next_cursor;
    }
  } catch (cause) {
    if (alive) {
      error.value =
        cause instanceof Error ? cause.message : "核验记录暂时不可用。";
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        records.value = [];
        members.value = [];
      }
    }
  } finally {
    if (alive) loading.value = false;
  }
}
async function propose() {
  if (!form.acknowledged || props.locked || loading.value) return;
  const result = await props.write("/personal/assurances", {
    org_id: props.orgId,
    user_id: form.user_id,
    guardian_user_id: form.guardian_user_id,
    evidence_reference: form.evidence_reference,
    policy_version: form.policy_version,
    transition_at: new Date(form.transition_at).toISOString(),
    expires_at: new Date(form.expires_at).toISOString(),
  });
  if (result && alive) {
    form.acknowledged = false;
    form.evidence_reference = "";
    emit("dirty", false);
    await load();
  }
}
async function review(item: S["LifelongAssuranceReview"], decision: Decision) {
  pendingReview.value = { item, decision };
}
async function confirmReview() {
  if (!pendingReview.value || props.locked || loading.value) return;
  const { item, decision } = pendingReview.value;
  if (
    await props.write(`/personal/assurances/${item.id}/review`, {
      revision: item.revision,
      decision,
    })
  ) {
    pendingReview.value = undefined;
    await load();
  }
}
onMounted(async () => {
  await load(false, true);
  await load();
});
onBeforeUnmount(() => {
  alive = false;
  life.abort();
});
</script>
<template>
  <section class="guardian-review stack">
    <h2>机构监护关系核验</h2>
    <p>
      仅当前学校组织的管理员可发起；另一个非当事人管理员独立复核。这里保存核验凭证的索引与政策版本，不上传身份证件或证明原件。
    </p>
    <p v-if="error" role="alert" class="notice">{{ error }}</p>
    <p v-if="loading" role="status">正在读取核验名单…</p>
    <form
      class="review-card"
      @input="emit('dirty', true)"
      @change="emit('dirty', true)"
      @submit.prevent="propose"
    >
      <h3>登记已核实的关系</h3>
      <fieldset :disabled="locked || loading">
        <label
          >学习者<select v-model="form.user_id" required>
            <option value="" disabled>选择本组织学习者</option>
            <option
              v-for="member in participants.filter((m) => !m.adult_admitted)"
              :key="member.user_id"
              :value="member.user_id"
            >
              {{ member.display_name }} · {{ member.user_id.slice(-6) }}
            </option>
          </select></label
        ><label
          >监护人<select v-model="form.guardian_user_id" required>
            <option value="" disabled>选择已完成成年准入的成员</option>
            <option
              v-for="member in participants.filter(
                (m) => m.adult_admitted && m.user_id !== form.user_id,
              )"
              :key="member.user_id"
              :value="member.user_id"
            >
              {{ member.display_name }} · {{ member.user_id.slice(-6) }}
            </option>
          </select></label
        ><button v-if="memberCursor" type="button" @click="load(true, true)">
          加载更多成员</button
        ><label
          >核验凭证索引<input
            v-model="form.evidence_reference"
            maxlength="120"
            required
            placeholder="机构内部核验记录编号，不填证件号码" /></label
        ><label
          >核验政策版本<input
            v-model="form.policy_version"
            maxlength="120"
            required /></label
        ><label
          >经核实的成年转段时间<input
            v-model="form.transition_at"
            type="datetime-local"
            required /></label
        ><label
          >本次核验截止时间<input
            v-model="form.expires_at"
            type="datetime-local"
            required /></label
        ><small
          >最长90天，且不超过成年转段时间。到期需重新核验；成年后的支持需本人重新授权。</small
        ><label class="check"
          ><input
            v-model="form.acknowledged"
            type="checkbox"
            required
          />我已依据本机构政策核实当事人及期限；模拟凭证只用于隔离试点。</label
        ><button type="submit" :disabled="!form.acknowledged">
          提交独立复核
        </button>
      </fieldset>
    </form>
    <div class="review-toolbar">
      <h3>当前组织的核验记录</h3>
      <button :disabled="locked || loading" @click="load()">重新读取</button>
    </div>
    <p v-if="!records.length && !loading">尚无核验记录。</p>
    <article v-for="item in records" :key="item.id" class="review-card">
      <h4>
        学习者
        {{
          members.find((m) => m.user_id === item.user_id)?.display_name ||
          "已授权关系当事人"
        }}
        / 监护人
        {{
          members.find((m) => m.user_id === item.guardian_user_id)
            ?.display_name || "已授权关系当事人"
        }}
      </h4>
      <p>
        状态：{{
          {
            pending: "待独立复核",
            approved: "已核验",
            rejected: "未通过",
            revoked: "已撤销",
          }[item.state]
        }}
      </p>
      <p>
        凭证索引：{{ item.evidence_reference }}；政策版本：{{
          item.policy_version
        }}
      </p>
      <p>
        核验截止：{{
          new Date(item.expires_at).toLocaleString("zh-CN")
        }}；成年转段：{{ new Date(item.transition_at).toLocaleString("zh-CN") }}
      </p>
      <p v-if="item.proposer_user_id === userId">
        由你发起，需另一名非当事人管理员独立复核。
      </p>
      <div v-else class="review-actions">
        <button
          v-if="item.state === 'pending'"
          :disabled="
            locked ||
            loading ||
            [item.user_id, item.guardian_user_id].includes(userId)
          "
          @click="review(item, 'approved')"
        >
          独立核验并通过</button
        ><button
          v-if="item.state === 'pending'"
          :disabled="
            locked ||
            loading ||
            [item.user_id, item.guardian_user_id].includes(userId)
          "
          @click="review(item, 'rejected')"
        >
          不予通过</button
        ><button
          v-if="item.state === 'approved'"
          :disabled="
            locked ||
            loading ||
            [item.user_id, item.guardian_user_id].includes(userId)
          "
          @click="review(item, 'revoked')"
        >
          撤销核验
        </button>
      </div>
      <section
        v-if="pendingReview?.item.id === item.id"
        class="review-card"
        aria-label="确认核验决定"
      >
        <h4>
          确认{{
            { approved: "通过核验", rejected: "不予通过", revoked: "撤销核验" }[
              pendingReview.decision
            ]
          }}
        </h4>
        <p v-if="pendingReview.decision === 'approved'">
          请确认你已独立核实上方当事人、凭证索引、政策版本及成年转段期限。测试凭证只用于隔离试点。
        </p>
        <p v-else>
          此决定提交后立即生效；撤销核验会停止相关支持关系的后续访问。
        </p>
        <div class="review-actions">
          <button :disabled="locked || loading" @click="confirmReview">
            确认提交核验决定
          </button>
          <button
            :disabled="locked || loading"
            @click="pendingReview = undefined"
          >
            取消核验决定
          </button>
        </div>
      </section>
    </article>
    <button v-if="cursor" :disabled="locked || loading" @click="load(true)">
      加载更多核验
    </button>
  </section>
</template>
<style scoped>
.stack {
  display: grid;
  gap: 1rem;
}
.review-card {
  padding: 1.25rem;
  border: 1px solid #cbdce7;
  border-radius: 12px;
  background: #fff;
  overflow-wrap: anywhere;
}
fieldset {
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 0;
  border: 0;
}
label {
  display: grid;
  gap: 0.5rem;
}
input,
select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0.6rem;
  border: 1px solid #a9bdcc;
  border-radius: 7px;
  font: inherit;
}
button {
  min-height: 44px;
  padding: 0.65rem 1rem;
  color: #174c72;
  border: 1px solid #adc5d7;
  border-radius: 8px;
  background: white;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.check,
.review-actions,
.review-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}
.check input {
  width: 20px;
  min-height: 20px;
  flex-shrink: 0;
}
p {
  line-height: 1.7;
}
small {
  color: #415d72;
}
:is(button, input, select):focus-visible {
  outline: 3px solid #168bd0;
  outline-offset: 3px;
}
</style>
