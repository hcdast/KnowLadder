<script setup lang="ts">
import {
  computed,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  nextTick,
} from "vue";
import { ApiError, type BusinessRequest } from "../session";
type Row = Record<string, any>;
const props = defineProps<{
  request: BusinessRequest;
  write: (path: string, body: unknown) => Promise<any>;
  caps: string[];
  catalog: { classes: Row[]; subjects: Row[]; assignments: Row[] };
  blocked: boolean;
  userId: string;
  receipt: Row | null;
}>();
const emit = defineEmits<{ dirty: [boolean] }>();
const rows = ref<Record<string, Row[]>>({
  locations: [],
  schedule: [],
  attendance: [],
  leave: [],
  paths: [],
  assignments: [],
  certificates: [],
  notifications: [],
});
const courses = ref<Row[]>([]),
  teachers = ref<Row[]>([]),
  message = ref(""),
  busy = ref(false),
  dirty = ref(false),
  page = ref("schedule"),
  selected = ref<Row | null>(null),
  note = ref(""),
  title = ref(""),
  classId = ref(""),
  subjectId = ref(""),
  courseId = ref(""),
  teacherId = ref(""),
  locationId = ref(""),
  start = ref(""),
  end = ref(""),
  originalId = ref(""),
  locationTitle = ref(""),
  pathCourses = ref<string[]>([]),
  pathTasks = ref<string[]>([]),
  gradeTasks = ref<Row[]>([]),
  pendingAction = ref<{ label: string; run: () => Promise<unknown> } | null>(
    null,
  ),
  gradeMin = ref(60),
  leaveReason = ref(""),
  attendanceEntries = ref<Row[]>([]),
  qualification = ref<Row | null>(null),
  certificateToken = ref(""),
  overview = ref<Row[]>([]);
const cancelButton = ref<HTMLButtonElement>();
let alive = true,
  epoch = 0,
  timer = 0;
const has = (cap: string) => props.caps.includes(cap),
  staff = computed(() =>
    props.caps.some((x) =>
      [
        "training:schedule-manage",
        "training:attendance-edit",
        "training:attendance-review",
        "training:path-edit",
        "training:path-review",
        "training:certificate-issue",
        "training:certificate-revoke",
        "training:operations-read",
      ].includes(x),
    ),
  ),
  subjects = computed(() =>
    props.catalog.subjects.filter((s) =>
      props.catalog.assignments.some(
        (a) => a.class_id === classId.value && a.subject_id === s.id,
      ),
    ),
  ),
  availableTeachers = computed(() =>
    teachers.value.filter(
      (t) => t.class_id === classId.value && t.subject_id === subjectId.value,
    ),
  );
const labels: Record<string, string> = {
  draft: "草稿",
  review: "待独立审核",
  published: "已发布",
  ended: "已结束",
  cancelled: "已取消",
  confirmed: "已确认",
  requested: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  retired: "已撤回",
  issued: "已签发",
  revoked: "已撤销",
  present: "到场",
  late: "迟到",
  absent: "缺席",
  excused: "批准请假",
};
function mark() {
  dirty.value = true;
  emit("dirty", true);
}
function clean() {
  dirty.value = false;
  emit("dirty", false);
}
function clear() {
  epoch++;
  rows.value = {
    locations: [],
    schedule: [],
    attendance: [],
    leave: [],
    paths: [],
    assignments: [],
    certificates: [],
    notifications: [],
  };
  selected.value = null;
  note.value = "";
  title.value = "";
  classId.value = "";
  subjectId.value = "";
  attendanceEntries.value = [];
  qualification.value = null;
  certificateToken.value = "";
  teachers.value = [];
  courses.value = [];
  gradeTasks.value = [];
  overview.value = [];
  pendingAction.value = null;
  leaveReason.value = "";
  pathTasks.value = [];
  pathCourses.value = [];
  start.value = "";
  end.value = "";
  originalId.value = "";
  locationTitle.value = "";
  clean();
}
async function read<T>(path: string) {
  const e = epoch,
    data = await props.request<T>(path);
  if (!alive || e !== epoch) throw new DOMException("视图已变化", "AbortError");
  return data;
}
function failure(e: unknown) {
  if (!alive || (e instanceof DOMException && e.name === "AbortError")) return;
  if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) clear();
  message.value = e instanceof Error ? e.message : "教务读取失败";
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    for (const kind of [
      "schedule",
      "leave",
      "paths",
      "assignments",
      "certificates",
      "notifications",
      ...(staff.value ? ["attendance"] : []),
    ])
      rows.value[kind] = (
        await read<{ items: Row[] }>("/training/phase2/" + kind)
      ).items;
    if (has("training:schedule-manage"))
      rows.value.locations = (
        await read<{ items: Row[] }>("/training/phase2/locations")
      ).items;
    if (staff.value) {
      const catalog = await read<{ teachers: Row[]; tasks: Row[] }>(
        "/training/phase2-catalog",
      );
      teachers.value = catalog.teachers;
      gradeTasks.value = catalog.tasks;
      if (
        has("training:schedule-manage") ||
        has("training:path-edit") ||
        has("training:path-review") ||
        has("training:certificate-issue")
      )
        courses.value = (
          await read<{ items: Row[] }>("/training/courses")
        ).items.filter((x) => x.status === "published");
    }
    if (has("training:operations-read"))
      overview.value = (
        await read<{ items: Row[] }>("/training/phase2-overview")
      ).items;
  } catch (e) {
    failure(e);
  } finally {
    busy.value = false;
  }
}
function choosePage(next: string) {
  if (dirty.value) {
    message.value = "请先保存当前表单，再切换功能。";
    return;
  }
  page.value = next;
  selected.value = null;
  qualification.value = null;
  certificateToken.value = "";
}
function choose(row: Row) {
  if (dirty.value) {
    message.value = "请先保存当前表单。";
    return;
  }
  selected.value = row;
  note.value = "";
  if(page.value==='paths'){classId.value=row.class_id;subjectId.value=row.subject_id;title.value=row.title;pathCourses.value=[...row.course_ids];pathTasks.value=[...row.task_ids];gradeMin.value=row.grade_min;}
  if (row.start_at) {
    start.value = localTime(row.start_at);
    end.value = localTime(row.end_at);
  }
  const attendance = rows.value.attendance?.find(
    (x) => x.session_id === row._id,
  );
  attendanceEntries.value = (row.recipients ?? []).map((member_id: string) => ({
    member_id,
    status:
      attendance?.entries.find((x: Row) => x.member_id === member_id)?.status ??
      "absent",
  }));
}
async function write(path: string, body: unknown) {
  const row = await props.write("/training/phase2" + path, body);
  if (row && alive) {
    clean();
    message.value = "操作已保存";
    if (row.verification_token) certificateToken.value = row.verification_token;
    await load();
    if (selected.value) {
      const replacement = rows.value[page.value]?.find(
        (x) => x._id === selected.value?._id,
      );
      if (replacement) {
        selected.value = replacement;
        const attendance = rows.value.attendance?.find(
          (x) => x.session_id === replacement._id,
        );
        attendanceEntries.value = (replacement.recipients ?? []).map(
          (member_id: string) => ({
            member_id,
            status:
              attendance?.entries.find((x: Row) => x.member_id === member_id)
                ?.status ?? "absent",
          }),
        );
      }
    }
  }
  return row;
}
async function createSchedule() {
  if (
    !Number.isFinite(new Date(start.value).getTime()) ||
    !Number.isFinite(new Date(end.value).getTime())
  ) {
    message.value = "请填写有效的开始和结束时间";
    return;
  }
  await write("/schedule", {
    class_id: classId.value,
    subject_id: subjectId.value,
    title: title.value,
    course_id: courseId.value,
    teacher_member_id: teacherId.value,
    location_id: locationId.value,
    start_at: new Date(start.value).toISOString(),
    end_at: new Date(end.value).toISOString(),
    original_session_id: originalId.value || null,
  });
}
async function actSchedule(action: string) {
  if (!selected.value) return;
  await write("/schedule/" + selected.value._id + "/actions", {
    action,
    expected_revision: selected.value.revision,
    note: note.value,
    ...(action === "reschedule"
      ? {
          start_at: new Date(start.value).toISOString(),
          end_at: new Date(end.value).toISOString(),
        }
      : {}),
  });
}
async function actAttendance(action: string) {
  if (!selected.value) return;
  const a = rows.value.attendance?.find(
    (x) => x.session_id === selected.value?._id,
  );
  await write("/schedule/" + selected.value._id + "/attendance", {
    action,
    expected_revision: a?.revision ?? 0,
    note: note.value,
    ...(action === "save" ? { entries: attendanceEntries.value } : {}),
  });
}
async function createPath() {
  await write(selected.value?.status==='draft'?'/paths/'+selected.value._id+'/actions':'/paths', {
    ...(selected.value?.status==='draft'?{action:'edit',expected_revision:selected.value.revision}:{}),
    ...(selected.value?.status==='draft'?{}:{class_id:classId.value,subject_id:subjectId.value}),
    title: title.value,
    course_ids: pathCourses.value,
    task_ids: pathTasks.value,
    attendance_bp: 8000,
    grade_min: gradeMin.value,
  });
}
async function pathAction(action: string) {
  if (selected.value)
    await write("/paths/" + selected.value._id + "/actions", {
      action,
      expected_revision: selected.value.revision,
      note: note.value,
    });
}
async function check(row: Row) {
  try {
    selected.value = row;
    qualification.value = await read<Row>(
      "/training/phase2/completions/" + row._id,
    );
  } catch (e) {
    failure(e);
  }
}
let confirmationOrigin: HTMLElement | null = null;
async function cancelConfirmation() {
  pendingAction.value = null;
  await nextTick();
  if (confirmationOrigin?.isConnected) confirmationOrigin.focus();
  confirmationOrigin = null;
}
async function confirm(label: string, run: () => Promise<unknown>) {
  confirmationOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pendingAction.value = { label, run };
  await nextTick();
  cancelButton.value?.focus();
}
async function proceed() {
  const action = pendingAction.value;
  pendingAction.value = null;
  if (action) await action.run();
}
function independent(row: Row) {
  return !(row.contributors ?? []).includes(props.userId);
}
function attendanceAllowed(action: string) {
  const a = rows.value.attendance?.find(
    (x) => x.session_id === selected.value?._id,
  );
  return action === "save" || action === "request-review"
    ? !a || a.status === "draft"
    : action === "correct"
      ? a?.status === "confirmed"
      : a?.status === "review" && independent(a);
}
function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
async function recheck() {
  if (busy.value || props.blocked) return;
  try {
    const data = await read<{ items: Row[] }>(
      "/training/phase2/" +
        (page.value === "schedule" ? "schedule" : page.value),
    );
    if (
      selected.value &&
      !data.items.some((x) => x._id === selected.value?._id) &&
      page.value !== "certificates"
    ) {
      clear();
      message.value = "当前记录已不可访问，已清空视图";
    }
    if (!dirty.value) rows.value[page.value] = data.items;
  } catch (e) {
    failure(e);
  }
}
onMounted(() => {
  void load();
  timer = window.setInterval(() => void recheck(), 30000);
});
onBeforeUnmount(() => {
  alive = false;
  epoch++;
  window.clearInterval(timer);
  emit("dirty", false);
});
watch(
  () => props.receipt,
  async (value) => {
    if (value) {
      clean();
      if (value.verification_token)
        certificateToken.value = value.verification_token;
      await load();
    }
  },
);
</script>
<template>
  <section class="panel" aria-label="教务结业与通知" :aria-busy="busy">
    <h3>课表、结业与通知</h3>
    <p class="muted">
      课程完成与知识掌握分别统计；结业由确定性规则核对、独立审核人签发。
    </p>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <div
      v-if="pendingAction"
      role="alertdialog"
      aria-label="确认教务操作"
      class="notice"
      @keydown.esc.prevent="cancelConfirmation"
    >
      <p>{{ pendingAction.label }}</p>
      <div class="actions">
        <button
          ref="cancelButton"
          class="button secondary"
          @click="cancelConfirmation"
        >
          取消</button
        ><button class="button" :disabled="blocked" @click="proceed">
          确认操作
        </button>
      </div>
    </div>
    <div class="actions">
      <button
        v-for="[key, name] in [
          ['schedule', '课表与考勤'],
          ['leave', '请假'],
          ['paths', '学习路径'],
          ['certificates', '结业证书'],
          ['notifications', '站内通知'],
        ]"
        :key="key"
        type="button"
        class="button secondary"
        :aria-pressed="page === key"
        @click="choosePage(key!)"
      >
        {{ name }}</button
      ><button
        type="button"
        class="button secondary"
        :disabled="busy"
        @click="load"
      >
        刷新教务记录</button
      ><button
        v-if="dirty"
        type="button"
        class="button secondary"
        :disabled="blocked"
        @click="
          confirm('放弃当前未保存表单？', async () => {
            clear();
            await load();
          })
        "
      >
        放弃未保存表单
      </button>
    </div>
    <template v-if="page === 'schedule'">
      <ul>
        <li v-for="row in rows.schedule" :key="row._id">
          <button type="button" class="text-button" @click="choose(row)">
            {{ row.title }} · {{ labels[row.status] }} ·
            {{ new Date(row.start_at).toLocaleString() }}
          </button>
        </li>
      </ul>
      <p v-if="!rows.schedule?.length">暂无可访问课次。</p>
      <div v-if="selected" class="notice">
        <h4>{{ selected.title }}</h4>
        <p>
          {{ new Date(selected.start_at).toLocaleString() }} —
          {{ new Date(selected.end_at).toLocaleString() }} ·
          {{ labels[selected.status] }}
        </p>
        <label>操作说明<input v-model="note" maxlength="2000" /></label>
        <div v-if="has('training:schedule-manage')" class="actions">
          <button
            v-if="selected.status === 'draft'"
            class="button"
            :disabled="blocked"
            @click="actSchedule('publish')"
          >
            发布课次</button
          ><button
            v-if="
              selected.status === 'published' &&
              new Date(selected.end_at).getTime() <= Date.now()
            "
            class="button secondary"
            :disabled="blocked"
            @click="actSchedule('end')"
          >
            确认课次结束</button
          ><button
            v-if="['draft', 'published'].includes(selected.status)"
            class="button secondary"
            :disabled="blocked || !note.trim()"
            @click="
              confirm('取消此课次并通知学员？', () => actSchedule('cancel'))
            "
          >
            确认取消课次
          </button>
        </div>
        <div
          v-if="
            has('training:schedule-manage') &&
            selected.status === 'published' &&
            new Date(selected.start_at).getTime() > Date.now()
          "
          class="form-grid"
        >
          <label
            >调整后的开始时间<input
              v-model="start"
              type="datetime-local"
              @input="mark" /></label
          ><label
            >调整后的结束时间<input
              v-model="end"
              type="datetime-local"
              @input="mark" /></label
          ><button
            class="button secondary"
            :disabled="blocked || !start || !end"
            @click="
              confirm('调整时间并重新核对冲突？', () =>
                actSchedule('reschedule'),
              )
            "
          >
            调课
          </button>
        </div>
        <template
          v-if="
            staff &&
            ['published', 'ended'].includes(selected.status) &&
            new Date(selected.start_at).getTime() <= Date.now()
          "
          ><h4>课次考勤</h4>
          <p>保存后送独立审核；批准请假不计到场课时。</p>
          <label v-for="entry in attendanceEntries" :key="entry.member_id"
            >学员 {{ entry.member_id.slice(-6)
            }}<select v-model="entry.status" @change="mark">
              <option value="present">到场</option>
              <option value="late">迟到</option>
              <option value="absent">缺席</option>
              <option value="excused">批准请假</option>
            </select></label
          >
          <div class="actions">
            <button
              v-for="[action, name, cap] in [
                ['save', '保存考勤', 'training:attendance-edit'],
                ['request-review', '送审考勤', 'training:attendance-edit'],
                ['confirm', '独立确认考勤', 'training:attendance-review'],
                ['reject', '退回考勤', 'training:attendance-review'],
                ['correct', '更正考勤', 'training:attendance-edit'],
              ]"
              :key="action"
              v-show="has(cap!) && attendanceAllowed(action!)"
              class="button secondary"
              :disabled="blocked"
              @click="actAttendance(action!)"
            >
              {{ name }}
            </button>
          </div></template
        >
        <form
          v-if="has('learning:self') && selected.status === 'published'"
          @submit.prevent="
            write('/leave', { session_id: selected._id, reason: leaveReason })
          "
        >
          <label
            >请假说明<input
              v-model="leaveReason"
              maxlength="500"
              required
              @input="mark" /></label
          ><button class="button" :disabled="blocked">申请本人请假</button>
        </form>
      </div>
      <form
        v-if="has('training:schedule-manage')"
        @submit.prevent="createSchedule"
      >
        <h4>创建单次课</h4>
        <div class="form-grid">
          <label
            >班级<select
              v-model="classId"
              required
              @change="
                subjectId = '';
                mark();
              "
            >
              <option value="">请选择</option>
              <option v-for="c in catalog.classes" :key="c.id" :value="c.id">
                {{ c.name }}
              </option>
            </select></label
          ><label
            >学科<select v-model="subjectId" required @change="mark">
              <option value="">请选择</option>
              <option v-for="s in subjects" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select></label
          ><label
            >课程<select v-model="courseId" required @change="mark">
              <option value="">请选择已发布课程</option>
              <option
                v-for="c in courses.filter((x) => x.subject_id === subjectId)"
                :key="c.id"
                :value="c.id"
              >
                {{ c.title }}
              </option>
            </select></label
          ><label
            >授课教师<select v-model="teacherId" required @change="mark">
              <option value="">请选择</option>
              <option
                v-for="t in availableTeachers"
                :key="t.member_id"
                :value="t.member_id"
              >
                {{ t.name }}
              </option>
            </select></label
          ><label
            >场地<select v-model="locationId" required @change="mark">
              <option value="">请选择</option>
              <option v-for="l in rows.locations" :key="l._id" :value="l._id">
                {{ l.title }}
              </option>
            </select></label
          ><label
            >课次名称<input
              v-model="title"
              maxlength="200"
              required
              @input="mark" /></label
          ><label
            >开始时间<input
              v-model="start"
              type="datetime-local"
              required
              @input="mark" /></label
          ><label
            >结束时间<input
              v-model="end"
              type="datetime-local"
              required
              @input="mark" /></label
          ><label
            >补课关联<select v-model="originalId" @change="mark">
              <option value="">普通课次</option>
              <option
                v-for="l in rows.schedule?.filter(
                  (x) =>
                    ['ended', 'cancelled'].includes(x.status) &&
                    !x.original_session_id,
                )"
                :key="l._id"
                :value="l._id"
              >
                {{ l.title }}
              </option>
            </select></label
          >
        </div>
        <button class="button" :disabled="blocked">保存课次草稿</button>
      </form>
      <form
        v-if="has('training:schedule-manage')"
        @submit.prevent="write('/locations', { title: locationTitle })"
      >
        <label
          >新增场地名称<input
            v-model="locationTitle"
            maxlength="200"
            required
            @input="mark" /></label
        ><button class="button secondary" :disabled="blocked">创建场地</button>
      </form>
    </template>
    <template v-if="page === 'leave'"
      ><ul>
        <li v-for="row in rows.leave" :key="row._id">
          <p>{{ labels[row.status] }} · {{ row.reason }}</p>
          <label>审批说明<input v-model="note" maxlength="2000" /></label>
          <div class="actions">
            <button
              v-if="
                has('training:attendance-edit') && row.status === 'requested'
              "
              class="button"
              :disabled="blocked"
              @click="
                write('/leave/' + row._id + '/actions', {
                  action: 'approve',
                  expected_revision: row.revision,
                  note,
                })
              "
            >
              批准请假</button
            ><button
              v-if="
                has('training:attendance-edit') && row.status === 'requested'
              "
              class="button secondary"
              :disabled="blocked"
              @click="
                write('/leave/' + row._id + '/actions', {
                  action: 'reject',
                  expected_revision: row.revision,
                  note,
                })
              "
            >
              拒绝请假</button
            ><button
              v-if="has('learning:self') && row.status === 'requested'"
              class="button secondary"
              :disabled="blocked"
              @click="
                write('/leave/' + row._id + '/actions', {
                  action: 'cancel',
                  expected_revision: row.revision,
                  note: '',
                })
              "
            >
              取消本人申请
            </button>
          </div>
        </li>
      </ul></template
    >
    <template v-if="page === 'paths'"
      ><ul>
        <li v-for="row in rows.paths" :key="row._id">
          <button class="text-button" @click="choose(row)">
            {{ row.title }} · {{ labels[row.status] }}
          </button>
        </li>
      </ul>
      <div v-if="selected">
        <label>路径审核说明<input v-model="note" maxlength="2000" /></label>
        <div class="actions">
          <button
            v-if="has('training:path-edit') && selected.status === 'draft'"
            class="button"
            :disabled="blocked"
            @click="pathAction('request-review')"
          >
            提交路径审核</button
          ><button
            v-if="
              has('training:path-review') &&
              selected.status === 'review' &&
              independent(selected)
            "
            class="button"
            :disabled="blocked || !note.trim()"
            @click="pathAction('publish')"
          >
            独立发布并指派</button
          ><button
            v-if="
              has('training:path-review') &&
              selected.status === 'review' &&
              independent(selected)
            "
            class="button secondary"
            :disabled="blocked || !note.trim()"
            @click="pathAction('reject')"
          >
            退回路径</button
          ><button
            v-if="has('training:path-edit') && selected.status === 'published'"
            class="button secondary"
            :disabled="blocked || !note.trim()"
            @click="
              confirm('撤回此路径，已有证书将重新核验？', () =>
                pathAction('retire'),
              )
            "
          >
            确认撤回路径
          </button>
        </div>
      </div>
      <button v-if="has('training:path-edit') && selected && selected.status!=='draft'" class="button secondary" @click="selected=null">创建新的路径草稿</button>
      <form v-if="has('training:path-edit') && (!selected || selected.status==='draft')" @submit.prevent="createPath">
        <h4>创建学习路径</h4>
        <label
          >班级<select
            v-model="classId"
            required
            @change="
              subjectId = '';
              mark();
            "
          >
            <option value="">请选择</option>
            <option v-for="c in catalog.classes" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select></label
        ><label
          >学科<select v-model="subjectId" required @change="mark">
            <option value="">请选择</option>
            <option v-for="s in subjects" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select></label
        ><label
          >路径名称<input
            v-model="title"
            required
            maxlength="200"
            @input="mark"
        /></label>
        <fieldset>
          <legend>必修课程（全部课节完成）</legend>
          <label
            v-for="c in courses.filter((x) => x.subject_id === subjectId)"
            :key="c.id"
            ><input
              v-model="pathCourses"
              type="checkbox"
              :value="c.id"
              @change="mark"
            />{{ c.title }}</label
          >
        </fieldset>
        <p>到场课时至少80%；无已结束课次证据不能签发。</p>
        <fieldset>
          <legend>可选成绩条件</legend>
          <label
            v-for="task in gradeTasks.filter(
              (x) => x.class_id === classId && x.subject_id === subjectId,
            )"
            :key="task.id"
            ><input
              v-model="pathTasks"
              type="checkbox"
              :value="task.id"
              @change="mark"
            />{{ task.title }}（{{
              task.target_type === "quiz" ? "测验" : "作业"
            }}）</label
          >
        </fieldset>
        <label
          >成绩最低分<input
            v-model.number="gradeMin"
            type="number"
            min="0"
            max="100"
            @input="mark" /></label
        ><button class="button" :disabled="blocked">{{selected?.status==='draft'?'保存路径修改':'保存路径草稿'}}</button>
      </form></template
    >
    <template v-if="page === 'certificates'"
      ><h4>学习路径指派</h4>
      <ul>
        <li v-for="row in rows.assignments" :key="row._id">
          <span>{{ JSON.parse(row.rules_json).title }}</span
          ><button
            v-if="staff || has('learning:self')"
            class="text-button"
            @click="check(row)"
          >
            核对结业条件
          </button>
        </li>
      </ul>
      <div v-if="qualification && selected" class="notice">
        <p>
          {{ qualification.eligible ? "结业条件已满足" : "结业条件未满足" }} ·
          到场比例 {{ qualification.evidence.attendance_bp / 100 }}%
        </p>
        <ul>
          <li v-for="item in qualification.evidence.missing" :key="item">
            {{ item }}
          </li>
        </ul>
        <label>签发依据<input v-model="note" maxlength="2000" /></label
        ><button
          v-if="
            has('training:certificate-issue') &&
            !JSON.parse(selected.rules_json).contributors.includes(userId)
          "
          class="button"
          :disabled="blocked || !qualification.eligible || !note.trim()"
          @click="
            confirm('独立签发此结业证书？', () =>
              write('/certificates', { assignment_id: selected!._id, note }),
            )
          "
        >
          独立确认并签发
        </button>
      </div>
      <p v-if="certificateToken" class="notice" style="overflow-wrap: anywhere">
        证书已签发，请保存验证令牌：{{ certificateToken }}
        <a
          :href="'/verify-certificate?token=' + certificateToken"
          target="_blank"
          rel="noopener noreferrer"
          >打开公开验真</a
        >
      </p>
      <ul>
        <li v-for="row in rows.certificates" :key="row._id">
          <p>{{ row.number }} · {{ labels[row.status] }}</p>
          <label
            v-if="has('training:certificate-revoke') && row.status === 'issued'"
            >撤销依据<input v-model="note" maxlength="2000" /></label
          ><button
            v-if="has('training:certificate-revoke') && row.status === 'issued'"
            class="button secondary"
            :disabled="blocked || !note.trim()"
            @click="
              confirm('撤销此证书并通知学员？', () =>
                write('/certificates/' + row._id + '/revoke', {
                  expected_revision: row.revision,
                  note,
                }),
              )
            "
          >
            确认撤销证书
          </button>
        </li>
      </ul></template
    >
    <template v-if="page === 'notifications'"
      ><p>站内通知在刷新时受控投递，来源失权时隐藏；不向外部渠道发送。</p>
      <ul>
        <li v-for="row in rows.notifications" :key="row._id">
          <p>{{ row.message }} · {{ row.read_at ? "已读" : "未读" }}</p>
          <button
            v-if="!row.read_at"
            class="text-button"
            :disabled="blocked"
            @click="
              write('/notifications/' + row._id + '/read', {
                expected_revision: row.revision,
              })
            "
          >
            标记已读
          </button>
        </li>
      </ul></template
    >
    <div v-if="has('training:operations-read')">
      <h4>本组织授课范围概览</h4>
      <p v-for="row in overview" :key="row.class_id">
        {{
          row.status === "insufficient"
            ? "样本不足5人，暂不展示聚合统计"
            : "有效学员 " +
              row.member_count +
              "，待上课 " +
              row.scheduled_count +
              "，已签发 " +
              row.issued_count
        }}
      </p>
    </div>
  </section>
</template>
