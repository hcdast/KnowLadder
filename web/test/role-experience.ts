import { createApp, nextTick, type Component } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import AssessmentAdmin from '../src/assessment/AssessmentAdmin.vue';
import ContentWorkspace from '../src/content/ContentWorkspace.vue';
import TrainingWorkspace from '../src/training/TrainingWorkspace.vue';
import TrainingWorkbench from '../src/training/TrainingWorkbench.vue';
import TeacherWorkspace from '../src/teaching/TeacherWorkspace.vue';
import AccountEmailSecurity from '../src/auth/AccountEmailSecurity.vue';
import { ApiError, type BusinessOptions, type BusinessRequest, type Identity } from '../src/session';
import '../src/styles.css';

const user = '111111111111111111111111', org = '222222222222222222222222', subject = '333333333333333333333333', question = '444444444444444444444444', member = '555555555555555555555555', quiz = '666666666666666666666666', clazz = '777777777777777777777777';
function identity(capabilities: string[]): Identity { return { user: { id: user, login_name: 'component-fixture', display_name: '合成测试用户' }, organizations: [{ id: org, name: '组件测试组织', kind: 'school' }], context: { org_id: org, member_id: member, capabilities, student_conflict: false }, must_change_password: false } as Identity; }
const results: { name: string; passed: boolean; detail?: string }[] = [];
const stage = document.querySelector<HTMLElement>('#stage')!;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
async function settled() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 15)); await nextTick(); }
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await settled(); } throw Error('组件未达到预期终态'); }
function button(text: string) { const row = Array.from(stage.querySelectorAll<HTMLButtonElement>('button')).find(row => row.textContent?.trim() === text); assert(row, `缺少按钮 ${text}`); return row; }
async function click(text: string) { const row = button(text); assert(!row.disabled, `按钮不可用 ${text}`); row.click(); await settled(); }
async function input(id: string, value: string) { const row = stage.querySelector<HTMLInputElement>(`#${id}`); assert(row, `缺少输入 ${id}`); row.value = value; row.dispatchEvent(new Event('input', { bubbles: true })); row.dispatchEvent(new Event('change', { bubbles: true })); await settled(); }
function fixture(handler: (path: string, options?: BusinessOptions) => Promise<unknown> | unknown): BusinessRequest { return async <T,>(path: string, options?: BusinessOptions) => structuredClone(await handler(path, options)) as T; }
async function mount(component: Component, props: Record<string, unknown>, route = '/training?tab=courses') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
  await router.push(route); const app = createApp(component, props).use(router); app.mount(stage); await settled(); return () => { app.unmount(); stage.replaceChildren(); };
}
async function run(name: string, behavior: () => Promise<void>) { try { await behavior(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) }); } }
const candidate = { id: question, title: '原创数值题', subject_id: subject, subject_name: '示例数学', difficulty: '基础', question_type: 'numeric', max_score: '10' };
const summary = { id: quiz, title: '分步考试', subject_id: subject, status: 'draft', revision: 1, created_by: user, contributors: [], opens_at: '2030-01-01T01:00:00.000Z', closes_at: '2030-01-01T02:00:00.000Z', release_at: '2030-01-01T03:00:00.000Z', duration_seconds: 900, max_attempts: 1 };
const fullQuiz = { ...summary, audience_member_ids: [member], items: [{ question_version_id: question, max_score: '10', question: { ...candidate, prompt: '1+1=?', answer: '2', options: [], explanation: '加法' } }] };
const catalog = { subjects: [{ id: subject, name: '示例数学' }], assignments: [{ class_id: clazz, subject_id: subject }], classes: [{ id: clazz, name: '测试班' }], quizzes: [], phase2_enabled: false, knowledge_enabled: false };

async function examFlow(failWrite: boolean) {
  const writes: { path: string; options?: BusinessOptions }[] = [];
  const request = fixture((path, options) => {
    if (options?.method === 'POST') { writes.push({ path, options }); if (failWrite) throw new DOMException('合成丢响应', 'TimeoutError'); return summary; }
    if (path.startsWith('/admin/quizzes?')) return { items: [], next_cursor: null };
    if (path === `/admin/quizzes/${quiz}`) return fullQuiz;
    if (path.startsWith('/admin/assessment-questions?')) return { items: [candidate, { ...candidate, id: '888888888888888888888888', subject_id: '999999999999999999999999', title: '另一学科题' }], next_cursor: null };
    if (path.startsWith('/admin/assessment-members?')) return { items: [{ id: member, display_name: '参加学员甲' }], next_cursor: null };
    throw Error(`未授权夹具请求 ${path}`);
  });
  const key = `assessment-admin-recovery:${user}:${org}`; const old = sessionStorage.getItem(key); sessionStorage.removeItem(key);
  const cleanup = await mount(AssessmentAdmin, { identity: identity(['assessment:manage']), request });
  try {
    await click('新建考试'); await click('4. 确认预览'); assert(stage.textContent?.includes('请填写考试标题'), '未校验跳步'); assert(writes.length === 0, '跳步发生写入');
    await input('quiz-title', '分步考试'); await input('quiz-opens_at', '2030-01-01T09:00'); await input('quiz-closes_at', '2030-01-01T10:00'); await input('quiz-release_at', '2030-01-01T11:00'); await input('quiz-duration', '0'); await click('下一步'); assert(stage.querySelector<HTMLInputElement>('#quiz-duration')?.value === '0' && stage.textContent!.includes('考试时长须为1至120分钟'), '非法零时长被默认值隐藏'); await input('quiz-duration', '15');
    await click('下一步'); await until(() => stage.textContent!.includes('原创数值题'));
    assert(stage.querySelector('#candidate-subject-name')?.textContent?.includes('示例数学'), '学科未按名称显示');
    await click('加入试卷');
    const other = Array.from(stage.querySelectorAll('li')).find(row => row.textContent?.includes('另一学科题'))?.querySelector('button:last-child') as HTMLButtonElement;
    other.click(); await settled(); assert(stage.textContent?.includes('题目学科必须一致'), '混学科题未拒绝');
    await click('下一步'); await until(() => stage.textContent!.includes('参加学员甲'));
    const person = stage.querySelector<HTMLInputElement>(`input[value="${member}"]`)!; person.checked = true; person.dispatchEvent(new Event('change', { bubbles: true })); await settled();
    await click('下一步'); assert(stage.textContent?.includes('15 分钟') && stage.textContent.includes('原创数值题') && stage.textContent.includes('参加学员甲'), '确认预览未显示人类可读数据');
    const save = button('保存考试草稿'); assert(save.getAttribute('form') === 'quiz-draft-form', '保存不属于分步表单'); save.click(); await until(() => writes.length === 1); await settled();
    const body = writes[0]!.options!.body as Record<string, unknown>;
    assert(body.duration_seconds === 900 && body.subject_id === subject && JSON.stringify(body.audience_member_ids) === JSON.stringify([member]), '分钟/名称转业务ID错误');
    if (failWrite) { assert(stage.textContent?.includes('管理请求结果待确认'), '丢响应未锁定'); assert(button('取消编辑').disabled, '未知写仍可取消'); const marker = sessionStorage.getItem(key); assert(marker && !marker.includes('分步考试') && !marker.includes('参加学员甲'), '恢复元数据丢失或保存正文'); }
    else { await until(() => stage.textContent!.includes('草稿已保存')); assert(!sessionStorage.getItem(key), '确认保存后未清除原请求标记'); }
  } finally { cleanup(); if (old === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, old); }
}

async function main() {
  await run('考试四步：拒绝跳步、同学科、名称受众、分钟映射和真实保存处理器', () => examFlow(false));
  await run('考试丢响应：保留原请求、禁止取消和新写，不持久化题面/受众', () => examFlow(true));
  await run('考试取消：空表单直接返回，修改后拒绝/确认均不发送业务写入', async () => {
    let writes = 0, confirms = 0, allow = false; const confirm = window.confirm;
    const cleanup = await mount(AssessmentAdmin, { identity: identity(['assessment:manage']), request: fixture((_, options) => { if (options?.method) writes++; return { items: [], next_cursor: null }; }) });
    try { window.confirm = () => { confirms++; return allow; }; await click('新建考试'); await click('返回考试列表'); assert(!stage.querySelector('#quiz-draft-form') && confirms === 0, '空表单错误询问'); await click('新建考试'); await input('quiz-title', '尚未提交'); await click('取消编辑'); assert(stage.querySelector('#quiz-draft-form'), '拒绝取消仍丢表单'); allow = true; await click('取消编辑'); assert(!stage.querySelector('#quiz-draft-form') && writes === 0 && confirms === 2, '取消提交了业务'); } finally { window.confirm = confirm; cleanup(); }
  });
  await run('审核默认待审过滤，阅读正文无编辑字段且保留合法审核操作', async () => {
    let release!: (value: unknown) => void; const options = new Promise(resolve => { release = resolve; });
    const version = { id: quiz, title: '原创教材', status: 'review', revision: 1, created_by: question, contributors: [], source_version_id: null, license: { source: '原创材料', granted: true, expires_at: null }, resource_ids: [] };
    const calls: string[] = [];
    const request = fixture(path => { calls.push(path); if (path === '/admin/content-options') return options; if (path.includes('/chapters?')) return { items: [{ id: 'intro', parent_id: null, position: 1, title: '基础概念', body: '便于阅读的章节正文', knowledge_point_ids: [], resource_ids: [] }], edition_revision: 1, next_cursor: null }; if (path.includes('audit-events')) return { items: [], next_cursor: null }; if (path.includes('?')) return { items: [version], next_cursor: null }; return version; });
    const cleanup = await mount(ContentWorkspace, { identity: identity(['content:review']), request });
    try { assert(stage.textContent?.includes('正在读取内容') && !stage.textContent.includes('暂无待审核'), '初始加载误报为空'); release({ education_stages: [], subjects: [], knowledge_points: [] }); await until(() => stage.textContent!.includes('原创教材')); assert(calls.some(path => path.includes('status=review')), '审核员未默认待审'); await click('查看与审核'); await until(() => stage.textContent!.includes('便于阅读的章节正文')); assert(!stage.querySelector('#chapter-body-intro') && !stage.querySelector('#edition-title') && !stage.querySelector('#chapter-title-intro'), '审核页仍有编辑正文表单'); assert(stage.querySelector('[aria-label="内容阅读与审核"]') && stage.textContent!.includes('审核'), '缺少阅读或审核区域'); } finally { cleanup(); }
  });
  await run('AI按需加载，AI慢请求不阻塞课程；403后迟到响应不能复活私有数据', async () => {
    const calls: string[] = []; let releaseAi!: (data: unknown) => void;
    const ai = new Promise(resolve => { releaseAi = resolve; });
    const request = fixture(path => { calls.push(path); if (path === '/training/catalog') return catalog; if (path === '/training/courses') return { items: [{ id: quiz, title: '可读取课程', status: 'draft', version_no: 1, created_by: user }] }; if (path === '/training/ai/status') return ai; if (path === '/training/ai/jobs') return { items: [] }; throw Error(path); });
    const cleanup = await mount(TrainingWorkspace, { identity: identity(['course:edit', 'ai:generate']), request });
    try { await until(() => stage.textContent!.includes('可读取课程')); assert(!calls.some(path => path.includes('/ai/')), '课程页预加载AI'); await click('AI 助手'); assert(stage.textContent!.includes('正在读取 AI') && !stage.textContent!.includes('AI 尚未配置'), 'AI加载误报未配置'); await click('课程管理'); assert(!button('新建课程').disabled && stage.textContent!.includes('可读取课程'), 'AI阻塞课程'); releaseAi({ configured: false, enabled: false }); await settled(); } finally { cleanup(); }
    let releaseCourses!: (data: unknown) => void; const courses = new Promise(resolve => { releaseCourses = resolve; });
    const cleanupDenied = await mount(TrainingWorkspace, { identity: identity(['course:edit']), request: fixture(path => { if (path === '/training/catalog') throw new ApiError(403, '夹具撤权'); if (path === '/training/courses') return courses; throw Error(path); }) });
    try { releaseCourses({ items: [{ id: quiz, title: '撤权后迟到的私有课程', status: 'draft' }] }); await settled(); assert(!stage.textContent?.includes('撤权后迟到的私有课程'), '撤权后迟到数据泄漏'); } finally { cleanupDenied(); }
  });
  await run('教师仅选择本班授课学科与名称题目，班级出卷取消有保护', async () => {
    const row = { id: clazz, name: '测试班', year_label: '测试学年', status: 'active', revision: 1 }; const calls: string[] = [];
    const request = fixture(path => { calls.push(path); if (path === '/teacher/classes') return { items: [row] }; if (path.includes('/roster')) return { class: row, items: [{ member_id: member, display_name: '测试学员' }] }; if (path === '/training/catalog') return { ...catalog, subjects: [...catalog.subjects, { id: quiz, name: '其他班学科' }] }; if (path.startsWith('/admin/assessment-questions?')) return { items: [candidate], next_cursor: null }; throw Error(path); });
    const cleanup = await mount(TeacherWorkspace, { identity: identity(['teaching:class', 'teaching:report', 'assessment:manage']), request }); const confirm = window.confirm;
    try { await click('打开名册'); await until(() => !!stage.querySelector('#teaching-subject option[value]')); const selector = stage.querySelector<HTMLSelectElement>('#teaching-subject')!; assert(selector.textContent!.includes('示例数学') && !selector.textContent!.includes('其他班学科') && selector.value === subject, '授课范围或单学科默认错误'); await click('从本班出卷'); await until(() => stage.textContent!.includes('原创数值题')); assert(stage.querySelector('#quiz-from-class-duration')?.getAttribute('max') === '120', '班级时长仍为秒'); window.confirm = () => false; await click('取消并返回名册'); assert(stage.querySelector('#quiz-from-class-title'), '取消拒绝仍丢草稿'); window.confirm = () => true; await click('取消并返回名册'); assert(!stage.querySelector('#quiz-from-class-title') && !calls.includes('/quizzes'), '取消发送写入'); } finally { window.confirm = confirm; cleanup(); }
  });
  await run('邮箱关闭时精简绑定表单，已绑定邮箱仍保留合法解绑入口', async () => {
    const props = { client: { capabilities: async () => ({ email_actions: false }), post: async () => { throw Error('不应写入'); } }, userId: user, loginName: '组件测试', emailState: 'unbound', maskedEmail: null, sessionChanged: async () => true, recoverSession: async () => undefined };
    let cleanup = await mount(AccountEmailSecurity, props); try { assert(stage.textContent!.includes('暂未开放绑定') && !stage.querySelector('form'), '关闭时仍显示冗余表单'); } finally { cleanup(); }
    cleanup = await mount(AccountEmailSecurity, { ...props, emailState: 'verified', maskedEmail: 't***@example.invalid' }); try { assert(stage.textContent!.includes('解除当前恢复邮箱') && stage.querySelectorAll('form').length === 1, '关闭申请错误隐藏解绑'); } finally { cleanup(); }
  });
  await run('本人工作台保留不可用提示，未开放模块折叠，嵌入时不重复标题', async () => {
    const cleanup = await mount(TrainingWorkbench, { embedded: true, request: fixture(() => ({ modules: { courses: { status: 'unavailable', items: [] }, tasks: { status: 'ready', items: [] }, certificates: { status: 'disabled', items: [] } } })) });
    try { assert(!stage.querySelector('h3'), '嵌入工作台仍重复标题'); assert(stage.textContent!.includes('数据暂不可用') && stage.textContent!.includes('暂无当前可访问数据'), '不可用与空数据混淆'); const more = Array.from(stage.querySelectorAll('details')).find(row => row.querySelector('summary')?.textContent === '更多功能'); assert(more && !more.open && more.textContent!.includes('本人证书'), '未开放模块未折叠或伪装空数据'); } finally { cleanup(); }
  });
  await run('AI读取失败单独重试，未确认配置不允许生成', async () => {
    let reads = 0;
    const cleanup = await mount(TrainingWorkspace, { identity: identity(['course:edit', 'ai:generate']), request: fixture(path => { if (path === '/training/catalog') return catalog; if (path === '/training/courses') return { items: [] }; if (path === '/training/ai/status') { reads++; if (reads === 1) throw Error('合成AI读取故障'); return { configured: false, enabled: false }; } if (path === '/training/ai/jobs') return { items: [] }; throw Error(path); }) }, '/training?tab=ai');
    try { await until(() => stage.textContent!.includes('合成AI读取故障')); assert(button('创建生成任务').disabled && !stage.textContent!.includes('AI 尚未配置'), '读取失败伪装配置状态或放行生成'); await click('重新读取 AI'); await until(() => stage.textContent!.includes('AI 尚未配置')); assert(reads === 2 && button('创建生成任务').disabled, '重试或未启用禁用错误'); } finally { cleanup(); }
  });
  const output = document.querySelector<HTMLElement>('#results')!; output.textContent = JSON.stringify({ passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length, results }, null, 2); output.dataset.complete = 'true';
}
void main();
