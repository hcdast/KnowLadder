import { createApp, nextTick, reactive, h, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import LearningDiscovery from '../src/training/LearningDiscovery.vue';
import LifelongExplore from '../src/site/LifelongExplore.vue';
import TrainingWorkspace from '../src/training/TrainingWorkspace.vue';
import { ApiError, type BusinessRequest, type Identity } from '../src/session';
import '../src/styles.css';
const stage = document.querySelector<HTMLElement>('#stage')!;
const results: { name: string; passed: boolean; detail?: string }[] = [];
function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
async function settled() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 10)); await nextTick(); }
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await settled(); } throw Error('组件未达到预期状态'); }
const rows = [
  { id: '111111111111111111111111', title: '观察与表达', status: 'published', revision: 3, subject_id: '222222222222222222222222', subject_name: '科学', version_no: 1, lesson_count: 2, formats: ['text', 'video'] },
  { id: '333333333333333333333333', title: '日常阅读与反思', status: 'published', revision: 2, subject_id: '444444444444444444444444', subject_name: '阅读', version_no: 1, lesson_count: 1, formats: ['text'] },
];
function request(handler: (path: string) => unknown | Promise<unknown>): BusinessRequest { return async <T,>(path: string) => await handler(path) as T; }
async function mount(component: Component, props: Record<string, unknown>, route = '/explore') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
  await router.push(route); const app = createApp({ render: () => h(component, props) }).use(router); app.mount(stage); await settled();
  return Object.assign(() => { app.unmount(); stage.replaceChildren(); }, { state: (app as any)._instance.subTree.component.setupState });
}
async function click(text: string) { const element = [...stage.querySelectorAll('button')].find(row => row.textContent?.trim() === text); assert(element, '缺少按钮 ' + text); element.click(); await settled(); }
async function field(selector: string, value: string) { const element = stage.querySelector<HTMLInputElement | HTMLSelectElement>(selector); assert(element, '缺少字段 ' + selector); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); await settled(); }
async function run(name: string, work: () => Promise<void>) { try { await work(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, detail: e instanceof Error ? e.message : String(e) }); } }
for (const row of rows) Object.assign(row, { required_lesson_count: 1, lesson_titles: ['观察第一步'], updated_at: '2026-10-15T00:00:00Z' });
const catalogue = { items: rows, limit: 20, next_cursor: null };
await run('六阶段跨龄探索与家庭边界；不要求出生日期或生成假课程', async () => {
  const close = await mount(LifelongExplore, {});
  try { assert(stage.querySelectorAll('.stage-grid article').length === 6, '阶段覆盖不完整'); await click('银龄学习'); assert(stage.querySelectorAll('.stage-grid article').length === 1 && stage.querySelector('.stage-grid')?.textContent?.includes('数字生活'), '阶段筛选未生效'); assert(stage.querySelector('[aria-pressed="true"]')?.textContent === '银龄学习', '选中态错误'); await click('全部阶段'); assert(stage.querySelectorAll('.stage-grid article').length === 6 && stage.querySelectorAll('.field-grid li').length === 8, '全部/跨龄领域缺失'); assert(!stage.querySelector('input') && stage.textContent?.includes('监护需机构独立核验') && stage.textContent?.includes('有期限并可撤回'), '强制年龄或未说明家庭边界'); } finally { close(); }
});
await run('查找按钮应用服务端条件，空结果/清除/形态筛选与本人课程入口', async () => {
  let chosen = ''; const calls:string[]=[];
  const close = await mount(LearningDiscovery, { contextKey: 'self:org', request: request(path=>{
    calls.push(path);const q=new URL(path,'http://fixture').searchParams;
    if(q.get('q')==='不存在的课程')return {...catalogue,items:[]};
    if(q.get('q')==='科学'||q.get('format')==='video')return {...catalogue,items:[rows[0]]};
    return catalogue;
  }), onCourse: (id: string) => { chosen = id; } });
  try {assert(stage.querySelectorAll('.discovery-grid article').length===2,'授权资源未呈现');
    await field('input','科学');assert(calls.length===1,'编辑条件自动发请求');await click('查找资源');assert(stage.querySelectorAll('.discovery-grid article').length===1&&calls.at(-1)?.includes('q='),'未应用服务端条件');
    await click('学习《观察与表达》');assert(chosen===rows[0].id,'学习目标错误');await field('input','不存在的课程');await click('查找资源');assert(stage.textContent?.includes('暂无匹配')&&!stage.querySelector('.discovery-grid article'),'空态错误');
    await click('清除筛选');assert(stage.querySelectorAll('.discovery-grid article').length===2,'清除未查全目录');const selects=stage.querySelectorAll<HTMLSelectElement>('select');selects[1].value='video';selects[1].dispatchEvent(new Event('change',{bubbles:true}));await click('查找资源');assert(calls.at(-1)?.includes('format=video')&&stage.querySelectorAll('.discovery-grid article').length===1,'形态条件未提交');
  } finally {close();}
});
await run('权限撤回清空旧资源与可选学科；失败不显示成功空态', async () => {
  let deny = false;
  const close = await mount(LearningDiscovery, { contextKey: 'self:org', request: request(() => { if (deny) throw new ApiError(403, '撤权'); return catalogue; }) });
  try { deny = true; await click('刷新资源'); assert(stage.textContent?.includes('权限已变化') && !stage.textContent?.includes(rows[0].title) && !stage.querySelector('option[value="' + rows[0].subject_id + '"]'), '撤权缓存泄漏'); assert(!stage.textContent?.includes('暂无匹配'), '失败伪装空态'); } finally { close(); }
});
await run('组织切换后迟到响应不能回填旧资源', async () => {
  let release!: (value: unknown) => void; let calls = 0;
  const props = reactive({ contextKey: 'self:first', request: request(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : { items: [], limit: 200 }) });
  const close = await mount(LearningDiscovery, props);
  try { props.contextKey = 'self:second'; await settled(); release(catalogue); await settled(); assert(!stage.textContent?.includes(rows[0].title) && stage.textContent?.includes('暂无匹配'), '旧组织迟到数据回填'); } finally { close(); }
});
const org = '555555555555555555555555';
function identity(caps: string[]) { return { user: { id: rows[0].id, login_name: 'discovery-fixture', display_name: '合成学习者' }, organizations: [{ id: org, name: '隔离组织', kind: 'school' }], context: { org_id: org, member_id: rows[1].id, capabilities: caps, student_conflict: false }, must_change_password: false } as Identity; }
await run('学习工作区打开资源保持本人模式；教师深链不发本人发现请求', async () => {
  const calls: string[] = [];
  const fixture = request(path => { calls.push(path); if (path === '/training/catalog') return { classes: [], subjects: [], assignments: [], quizzes: [] }; if (path === '/training/courses' || path === '/training/tasks') return { items: [] }; if (path === '/training/discovery') return catalogue; if (path.includes('?mode=learner')) return { _id: rows[0].id, title: rows[0].title, revision: 1, status: 'published', lessons: [], progress: [] }; throw Error(path); });
  let close = await mount(TrainingWorkspace, { identity: identity(['learning:self']), request: fixture }, '/training?tab=discover');
  try { await until(() => !!stage.querySelector('.discovery-grid article')); await click('学习《观察与表达》'); assert(calls.includes('/training/courses/' + rows[0].id + '?mode=learner'), '打开课程升级到教学模式'); } finally { close(); }
  calls.length = 0; close = await mount(TrainingWorkspace, { identity: identity(['course:edit']), request: fixture }, '/training?tab=discover');
  try { assert(!calls.includes('/training/discovery') && stage.textContent?.includes('课程列表'), '教师深链空白或读取本人资源'); } finally { close(); }
});
await run('课程周期复核保留本人模式，撤权卸载目录且不循环请求', async () => {
  let deny = false; const calls: string[] = [];
  const close = await mount(TrainingWorkspace, { identity: identity(['learning:self']), request: request(path => {
    calls.push(path);
    if (path === '/training/catalog') return { classes: [], subjects: [], assignments: [], quizzes: [] };
    if (path === '/training/courses' || path === '/training/tasks') return { items: [] };
    if (path === '/training/discovery') return catalogue;
    if (path.endsWith('?mode=learner')) { if (deny) throw new ApiError(403, '撤权'); return { _id: rows[0].id, title: rows[0].title, revision: 1, status: 'published', lessons: [], progress: [] }; }
    throw Error('不应升级读取模式：' + path);
  }) }, '/training?tab=discover');
  try {
    await click('学习《观察与表达》'); await close.state.recheck();
    assert(calls.filter(path => path.endsWith('?mode=learner')).length === 2, '周期复核未沿用本人模式');
    await click('发现资源'); deny = true; await close.state.recheck(); await settled();
    const count = calls.length; await settled();
    assert(stage.textContent?.includes('权限已变化') && !stage.querySelector('.discovery-grid article') && calls.length === count, '失权目录残留或自动重读循环');
  } finally { close(); }
});
await run('分页沿已应用条件、追加去重，未提交查找草稿不进入续页',async()=>{
  const calls:string[]=[];const close=await mount(LearningDiscovery,{contextKey:'self:paging',request:request(path=>{
    calls.push(path);const q=new URL(path,'http://fixture').searchParams;
    return q.has('cursor')?{...catalogue,items:[rows[0],rows[1]]}:{...catalogue,items:[rows[0]],next_cursor:'opaque-next'};
  })});try{await field('input','未提交的查找');await click('继续查找课程');assert(calls.at(-1)?.includes('cursor=opaque-next')&&!calls.at(-1)?.includes('q='),'续页使用未应用草稿');assert(stage.querySelectorAll('.discovery-grid article').length===2,'追加重复或缺少新页');assert(![...stage.querySelectorAll('button')].some(b=>b.textContent?.trim()==='继续查找课程'),'尾页仍可继续');}finally{close();}
});
await run('三课比较有上限、目录预览与真实字段，刷新移除失效选择',async()=>{
  const many=[...rows,{...rows[0],id:'666666666666666666666666',title:'证据比较'},{...rows[0],id:'777777777777777777777777',title:'生活观察'}];let refresh=false;
  const close=await mount(LearningDiscovery,{contextKey:'self:compare',request:request(()=>({...catalogue,items:refresh?[rows[1]]:many}))});
  try{const compare=[...stage.querySelectorAll<HTMLButtonElement>('button[aria-label^="比较："]')];for(const b of compare.slice(0,3)){b.click();await settled();}assert(compare[3].disabled,'超过三课仍可加入');assert(stage.querySelectorAll('.comparison article').length===3&&stage.textContent?.includes('课节数量不等于学习难度'),'比较缺上限或混淆指标');stage.querySelector<HTMLElement>('summary')!.click();await settled();assert(stage.querySelector('details')?.open&&stage.textContent?.includes('观察第一步'),'没有目录预览');refresh=true;await click('刷新资源');assert(stage.querySelectorAll('.comparison article').length===1&&!stage.querySelector('.comparison')?.textContent?.includes(rows[0].title),'刷新保留失效比较');await click('清空比较');assert(!stage.querySelector('.comparison'),'不能清空比较');}finally{close();}
});
await run('续页失败清全部私有列表和比较，空候选批次仍允许继续',async()=>{
  let denied=false;const close=await mount(LearningDiscovery,{contextKey:'self:failure',request:request(path=>{
    if(denied)throw new ApiError(403,'撤权');return path.includes('cursor=')?{...catalogue,items:[rows[0]],next_cursor:'second'}:{...catalogue,items:[],next_cursor:'first'};
  })});try{assert(stage.textContent?.includes('继续查找后续课程'),'空批次误称没有课程');await click('继续查找课程');stage.querySelector<HTMLButtonElement>('button[aria-label^="比较："]')!.click();await settled();denied=true;await click('继续查找课程');assert(!stage.querySelector('.discovery-grid article')&&!stage.querySelector('.comparison')&&stage.textContent?.includes('权限已变化'),'失权残留列表或比较');}finally{close();}
});
const output = document.querySelector<HTMLElement>('#results')!;
output.textContent = JSON.stringify({ passed: results.filter(row => row.passed).length, failed: results.filter(row => !row.passed).length, results }, null, 2); output.dataset.complete = 'true';
