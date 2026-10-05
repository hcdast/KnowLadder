<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { BusinessRequest } from "../session";
import { consoleStatusLabel } from "./presentation";
import ResourceTable from "./components/ResourceTable.vue";
import StatusBadge from "./components/StatusBadge.vue";
interface Choice { id: string; name: string }
interface ClassReport { class_id: string; subject_id: string; status: string; roster_count: number; projected_count: number | null; mastery_bands: Record<string, number> | null; submission_count_7d: number | null; submission_count_30d: number | null; weak_knowledge_points: { knowledge_point_id: string; title: string; student_count: number }[]; rule_version: string }
interface StudentReport { class_id: string; subject_id: string; member_id: string; status: string; source_watermark: string | null; generated_at: string | null; rule_version: string; period: string; activity: { submission_count: number; independent_question_count: number; numerator: string; denominator: string; correctness: string | null } | null; mastery_window_days: number; mastery: { knowledge_point_id: string; independent_question_count: number; numerator: string; denominator: string; mastery: string | null; status: string; last_evidence_at: string }[] }
const props = defineProps<{ targetOrgId: string; consoleRequest: BusinessRequest }>();
const classes = ref<Choice[]>([]), subjects = ref<Choice[]>([]), students = ref<{ member_id: string }[]>([]), classCursor = ref<string | null>(null), subjectCursor = ref<string | null>(null), studentCursor = ref<string | null>(null);
const classId = ref(""), subjectId = ref(""), memberId = ref(""), period = ref("30d"), classReport = ref<ClassReport>(), studentReport = ref<StudentReport>();
const view = ref<"class" | "student">("class"), lastRequestStudent = ref(false);
const className = computed(() => classes.value.find(item => item.id === classId.value)?.name || "所选班级");
const subjectName = computed(() => subjects.value.find(item => item.id === subjectId.value)?.name || "所选学科");
const busy = ref(false), error = ref(""); const life = new AbortController(); let alive = true, generation = 0, rosterGeneration = 0;
const optionLoading = ref({ classes: false, subjects: false }), optionLoaded = ref({ classes: false, subjects: false }), optionError = ref({ classes: "", subjects: "" });
const rosterLoading = ref(false), rosterLoaded = ref(false), rosterError = ref("");
const headers = { "X-Target-Org-Id": props.targetOrgId };
function fail(cause: unknown) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) error.value = cause instanceof Error ? cause.message : "报告读取失败"; }
function clearReports() { generation++; classReport.value = undefined; studentReport.value = undefined; error.value = ""; }
async function options(next = false, resource: "classes" | "subjects" = "classes") {
  if (optionLoading.value[resource]) return;
  optionLoading.value[resource] = true; optionError.value[resource] = "";
  try {
    const q = new URLSearchParams({ resource, limit: "20" });
    const cursor = resource === "classes" ? classCursor.value : subjectCursor.value;
    if (next && cursor) q.set("cursor", cursor);
    const page = await props.consoleRequest<{ items: Choice[]; next_cursor: string | null }>(`/console/business/reports/options?${q}`, { headers, signal: life.signal });
    if (!alive) return;
    if (resource === "classes") { classes.value = next ? [...classes.value, ...page.items] : page.items; classCursor.value = page.next_cursor; }
    else { subjects.value = next ? [...subjects.value, ...page.items] : page.items; subjectCursor.value = page.next_cursor; }
    optionLoaded.value[resource] = true;
  } catch (cause) { if (alive && !(cause instanceof DOMException && cause.name === "AbortError")) optionError.value[resource] = cause instanceof Error ? cause.message : "选项读取失败"; }
  finally { if (alive) optionLoading.value[resource] = false; }
}
async function roster(next = false) {
  if (!classId.value || rosterLoading.value) return;
  const token = rosterGeneration; rosterLoading.value = true; rosterError.value = "";
  try {
    const q = new URLSearchParams({ class_id: classId.value, limit: "20" }); if (next && studentCursor.value) q.set("cursor", studentCursor.value);
    const page = await props.consoleRequest<{ items: { member_id: string }[]; next_cursor: string | null }>(`/console/business/reports/options?${q}`, { headers, signal: life.signal });
    if (alive && token === rosterGeneration) { students.value = next ? [...students.value, ...page.items] : page.items; studentCursor.value = page.next_cursor; rosterLoaded.value = true; }
  } catch (cause) { if (alive && token === rosterGeneration && !(cause instanceof DOMException && cause.name === "AbortError")) rosterError.value = cause instanceof Error ? cause.message : "在册学生读取失败"; }
  finally { if (alive && token === rosterGeneration) rosterLoading.value = false; }
}
function changeClass() { clearReports(); rosterGeneration++; students.value = []; studentCursor.value = null; memberId.value = ""; rosterLoading.value = false; rosterLoaded.value = false; rosterError.value = ""; if (view.value === "student") void roster(); }
function selectView(value: "class" | "student") { if (busy.value || view.value === value) return; view.value = value; clearReports(); if (value === "student" && classId.value && !rosterLoaded.value) void roster(); }
async function load(student = view.value === "student") {
  if (busy.value || !classId.value || !subjectId.value || student && !memberId.value) return;
  clearReports(); busy.value = true; lastRequestStudent.value = student; const token = generation;
  try {
    const base = `/console/business/reports/classes/${encodeURIComponent(classId.value)}/subjects/${encodeURIComponent(subjectId.value)}`;
    if (student) { const report = await props.consoleRequest<StudentReport>(`${base}/students/${encodeURIComponent(memberId.value)}?${new URLSearchParams({ period: period.value })}`, { headers, signal: life.signal }); if (alive && token === generation) studentReport.value = report; }
    else { const report = await props.consoleRequest<ClassReport>(base, { headers, signal: life.signal }); if (alive && token === generation) classReport.value = report; }
  } catch (cause) { if (token === generation) fail(cause); } finally { if (alive) busy.value = false; }
}
onMounted(() => { void options(); void options(false, "subjects"); }); onBeforeUnmount(() => { alive = false; generation++; life.abort(); classReport.value = undefined; studentReport.value = undefined; students.value = []; });
</script>
<template>
  <section class="admin-page reports-page">
    <header class="stack"><h2>已发布报告</h2><p class="admin-meta">只读服务端可披露的班级与学生证据；不代学生读取本人接口，不重建投影，不保存报告到浏览器。</p></header>
    <section class="admin-card stack" aria-label="报告范围">
      <nav class="actions" aria-label="报告类型"><button class="button secondary" :aria-pressed="view === 'class'" :disabled="busy" @click="selectView('class')">班级报告</button><button class="button secondary" :aria-pressed="view === 'student'" :disabled="busy" @click="selectView('student')">学生报告</button></nav>
      <form class="stack" @submit.prevent="load()">
        <div class="report-filters">
          <div class="field"><label for="report-class">班级</label><select id="report-class" v-model="classId" :disabled="busy || optionLoading.classes" required @change="changeClass"><option value="">选择班级</option><option v-for="item in classes" :key="item.id" :value="item.id">{{ item.name }}</option></select>
            <p v-if="optionLoading.classes" role="status">正在读取班级…</p>
            <div v-if="optionError.classes" class="notice" role="alert"><p>班级读取失败：{{ optionError.classes }}</p><button type="button" class="text-button" :disabled="busy || optionLoading.classes" @click="options(!!classCursor)">重试班级读取</button></div>
            <p v-if="optionLoaded.classes && !classes.length && !optionLoading.classes && !optionError.classes" class="field-help">当前范围没有可见班级。</p>
            <button v-if="classCursor && !optionError.classes" type="button" class="text-button" :disabled="busy || optionLoading.classes" @click="options(true)">加载更多班级</button>
          </div>
          <div class="field"><label for="report-subject">学科</label><select id="report-subject" v-model="subjectId" :disabled="busy || optionLoading.subjects" required @change="clearReports"><option value="">选择学科</option><option v-for="item in subjects" :key="item.id" :value="item.id">{{ item.name }}</option></select>
            <p v-if="optionLoading.subjects" role="status">正在读取学科…</p>
            <div v-if="optionError.subjects" class="notice" role="alert"><p>学科读取失败：{{ optionError.subjects }}</p><button type="button" class="text-button" :disabled="busy || optionLoading.subjects" @click="options(!!subjectCursor, 'subjects')">重试学科读取</button></div>
            <p v-if="optionLoaded.subjects && !subjects.length && !optionLoading.subjects && !optionError.subjects" class="field-help">当前范围没有可见学科。</p>
            <button v-if="subjectCursor && !optionError.subjects" type="button" class="text-button" :disabled="busy || optionLoading.subjects" @click="options(true, 'subjects')">加载更多学科</button>
          </div>
          <template v-if="view === 'student'">
            <div class="field"><label for="report-member">在册学生</label><select id="report-member" v-model="memberId" :disabled="busy || !classId || rosterLoading" required @change="clearReports"><option value="">选择在册学生</option><option v-for="item in students" :key="item.member_id" :value="item.member_id">成员 {{ item.member_id }}</option></select>
              <p class="field-help">当前接口仅提供成员标识，不推断姓名或登录名。</p>
              <p v-if="rosterLoading" role="status">正在读取在册学生…</p>
              <div v-if="rosterError" class="notice" role="alert"><p>在册学生读取失败：{{ rosterError }}</p><button type="button" class="text-button" :disabled="busy || rosterLoading" @click="roster(!!studentCursor)">重试在册学生读取</button></div>
              <p v-if="rosterLoaded && !students.length && !rosterLoading && !rosterError" class="field-help">当前班级没有可见在册学生。</p>
              <button v-if="studentCursor && !rosterError" type="button" class="text-button" :disabled="busy || rosterLoading" @click="roster(true)">加载更多在册学生</button>
            </div>
            <div class="field"><label for="report-period">活动周期</label><select id="report-period" v-model="period" :disabled="busy" @change="clearReports"><option value="7d">近7日</option><option value="30d">近30日</option></select></div>
          </template>
        </div>
        <div class="actions"><button class="button" :disabled="busy || !classId || !subjectId || view === 'student' && !memberId">{{ view === 'student' ? '读取学生报告' : '读取班级报告' }}</button></div>
      </form>
    </section>
    <p v-if="busy" role="status">正在读取已发布报告…</p>
    <div v-if="error" class="notice" role="alert"><p>报告读取失败：{{ error }}</p><button class="button secondary" :disabled="busy" @click="load(lastRequestStudent)">重试报告读取</button></div>
    <p v-if="!classReport && !studentReport && !busy && !error" class="admin-empty">选择班级和学科后读取报告。学生报告还需选择在册学生；尚未读取不代表没有证据。</p>
    <section v-if="classReport" class="admin-card stack" aria-label="班级报告详情">
      <div class="admin-toolbar"><h2>{{ className }} · {{ subjectName }}</h2><StatusBadge :status="classReport.status" /></div>
      <dl class="report-facts"><div><dt>在册学生</dt><dd>{{ classReport.roster_count }}</dd></div><div><dt>可用投影</dt><dd>{{ classReport.projected_count === null ? '暂不可披露' : classReport.projected_count }}</dd></div></dl>
      <details class="admin-meta"><summary>报告技术信息</summary><p>班级 {{ classReport.class_id }} · 学科 {{ classReport.subject_id }} · 规则 {{ classReport.rule_version }}</p></details>
      <template v-if="classReport.status === 'ready'">
        <dl class="report-facts"><div><dt>近7日提交</dt><dd>{{ classReport.submission_count_7d === null ? '证据不足' : classReport.submission_count_7d }}</dd></div><div><dt>近30日提交</dt><dd>{{ classReport.submission_count_30d === null ? '证据不足' : classReport.submission_count_30d }}</dd></div></dl>
        <h3>掌握分布</h3>
        <ResourceTable :headers="['掌握区间', '学生数']" :empty="!classReport.mastery_bands || !Object.keys(classReport.mastery_bands).length" empty-label="没有可披露的掌握分布证据。"><tr v-for="(count, band) in classReport.mastery_bands" :key="band"><td>{{ consoleStatusLabel(band) }}</td><td>{{ count }}</td></tr></ResourceTable>
        <h3>弱项知识点</h3>
        <ResourceTable :headers="['知识点', '弱项学生数']" :empty="!classReport.weak_knowledge_points.length" empty-label="当前已发布报告没有可披露的弱项知识点。"><tr v-for="point in classReport.weak_knowledge_points" :key="point.knowledge_point_id"><td>{{ point.title }}<details class="admin-meta"><summary>知识点标识</summary>{{ point.knowledge_point_id }}</details></td><td>{{ point.student_count }}</td></tr></ResourceTable>
      </template>
      <p v-else class="notice">报告{{ consoleStatusLabel(classReport.status) }}。证据未就绪或不足，不以零分或零值替代，也不触发重建。</p>
    </section>
    <section v-if="studentReport" class="admin-card stack" aria-label="学生报告详情">
      <div class="admin-toolbar"><h2>{{ className }} · {{ subjectName }} · 学生报告</h2><StatusBadge :status="studentReport.status" /></div>
      <dl class="report-facts"><div><dt>生成时间</dt><dd>{{ studentReport.generated_at || '未生成' }}</dd></div><div><dt>活动周期</dt><dd>{{ studentReport.period === '7d' ? '近7日' : studentReport.period === '30d' ? '近30日' : studentReport.period }}</dd></div><div><dt>掌握证据窗口</dt><dd>{{ studentReport.mastery_window_days }}日</dd></div></dl>
      <details class="admin-meta"><summary>对象与证据技术信息</summary><p>成员 {{ studentReport.member_id }} · 班级 {{ studentReport.class_id }} · 学科 {{ studentReport.subject_id }} · 规则 {{ studentReport.rule_version }}</p><p>证据水位 {{ studentReport.source_watermark || '无可发布证据' }}</p></details>
      <template v-if="studentReport.status === 'ready' || studentReport.status === 'insufficient_evidence'">
        <p v-if="studentReport.status === 'insufficient_evidence'" class="notice">证据不足：当前报告不能作为零分或完整掌握结论。以下仅展示服务端允许披露的局部证据。</p>
        <dl v-if="studentReport.activity" class="report-facts"><div><dt>提交数</dt><dd>{{ studentReport.activity.submission_count }}</dd></div><div><dt>独立题数</dt><dd>{{ studentReport.activity.independent_question_count }}</dd></div><div><dt>正确证据</dt><dd>{{ studentReport.activity.numerator }} / {{ studentReport.activity.denominator }}</dd></div><div><dt>正确率</dt><dd>{{ studentReport.activity.correctness === null ? '证据不足' : studentReport.activity.correctness }}</dd></div></dl>
        <p v-else class="admin-empty">当前活动周期没有可披露的证据，不以零值替代。</p>
        <h3>知识点掌握证据</h3>
        <ResourceTable :headers="['知识点标识', '证据状态', '掌握值', '独立题数', '正确证据', '末次证据']" :empty="!studentReport.mastery.length" empty-label="当前报告没有可披露的知识点掌握证据。">
          <tr v-for="point in studentReport.mastery" :key="point.knowledge_point_id"><td><details class="admin-meta"><summary>查看知识点标识</summary>{{ point.knowledge_point_id }}</details></td><td><StatusBadge :status="point.status" /></td><td>{{ point.mastery === null ? '证据不足' : point.mastery }}</td><td>{{ point.independent_question_count }}</td><td>{{ point.numerator }} / {{ point.denominator }}</td><td>{{ point.last_evidence_at }}</td></tr>
        </ResourceTable>
      </template>
      <p v-else class="notice">数据{{ consoleStatusLabel(studentReport.status) }}，证据正文不可披露；读取报告不会请求重建。</p>
    </section>
  </section>
</template>

<style scoped>
.report-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 16px; }
.report-filters .field, .report-filters select { min-width: 0; width: 100%; }
.report-facts { display: flex; flex-wrap: wrap; gap: 16px 32px; margin: 0; }
.report-facts dt { color: #667085; }
.report-facts dd { margin: 4px 0 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.reports-page h2 { margin: 0; font-size: 16px; line-height: 24px; }
.reports-page h3 { margin: 0; font-size: 14px; line-height: 22px; }
.reports-page details { overflow-wrap: anywhere; }
</style>
