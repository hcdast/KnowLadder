<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ApiError, type BusinessRequest } from '../session';
type Row = Record<string, any>;
const props = defineProps<{ request: BusinessRequest; write: (path: string, body: unknown) => Promise<Row | undefined>; caps: string[]; contextKey: string; blocked: boolean; recovered?: Row | null; initialTarget?:{kind:string;id:string} }>();
const emit = defineEmits<{ dirty: [boolean]; tasks: []; work:[string]; course: [string]; reading: [{ editionId: string; chapterId: string }] }>();
const learner = computed(() => props.caps.includes('learning:self')), canManage = computed(() => props.caps.includes('task:manage')), canAnswer = computed(() => props.caps.includes('coursework:grade'));
const kind = ref<'practice' | 'notes' | 'questions' | 'meetups'>(learner.value ? 'notes' : 'practice');
const mode = ref(learner.value ? 'learner' : 'staff'), catalog = ref<Row>({ pairs: [] }), pairKey = ref('');
const pair = computed(() => catalog.value.pairs.find((p: Row) => p.class_id+':'+p.subject_id === pairKey.value));
const rows = ref<Row[]>([]), detail = ref<Row | null>(null), cursor = ref<string | null>(null), busy = ref(false), dirty = ref(false), error = ref(''), query = ref(''), applied = ref('');
const denied = ref(false), detailHeading = ref<HTMLElement>();
const recoveredNotice = ref(false);
watch(()=>props.recovered,value=>{if(value)recoveredNotice.value=true;},{immediate:true});
async function readConfirmed(){if(blocked.value)return;resetForm();clear();dirty.value=false;recoveredNotice.value=false;await load();}
const form = reactive({ title: '', body: '', source_kind: 'course', source_id: '', lesson_key: '', due_on: '', reply: '', review_note: '', location: '', starts_at: '', ends_at: '', closes_at: '', capacity: 20, reflection: '', objectives: '', steps: '', deliverables: '', due_at: '' });
const rubric = ref([{ key: 'process', title: '实践过程', weight: 40 }, { key: 'outcome', title: '作品质量', weight: 40 }, { key: 'reflection', title: '反思改进', weight: 20 }]);
const sources = ref<Row[]>([]), sourceCursor = ref<string | null>(null), units = ref<Row[]>([]), unitCursor = ref<string | null>(null);
const writing = ref(false); let epoch = 0, alive = true, controller = new AbortController();
const blocked = computed(() => busy.value || writing.value || props.blocked);
const labels: Record<string,string> = { draft:'草稿',published:'已开放',cancelled:'已取消',completed:'已结束',open:'待答复',answered:'已答复',closed:'已解决',enrolled:'已报名',attended:'已参加',absent:'未参加' };
watch(dirty, value => emit('dirty', value), { flush: 'sync' });
function changed() { dirty.value = true; }
function resetForm() { for(const key of Object.keys(form))if(typeof (form as Row)[key]==='string')(form as Row)[key]='';form.source_kind='course';form.capacity=20;rubric.value=[{key:'process',title:'实践过程',weight:40},{key:'outcome',title:'作品质量',weight:40},{key:'reflection',title:'反思改进',weight:20}]; }
function clear() { rows.value=[]; detail.value=null; sources.value=[]; units.value=[]; cursor.value=null; sourceCursor.value=null; unitCursor.value=null; }
function failure(e: unknown) {
  if (!alive) return;
  error.value = e instanceof Error ? e.message : '读取失败，请重新加载。';
  if (e instanceof ApiError && [401,403,404].includes(e.status)) {
    denied.value=true;clear(); catalog.value={pairs:[]}; pairKey.value='';resetForm();dirty.value=false;
  }
}
async function read<T = Row>(path: string) { return props.request<T>(path, { signal: controller.signal }); }
async function load(more = false, apply = false) {
  if (!alive || busy.value || writing.value) return;
  if (apply) applied.value=query.value;
  const token=epoch; busy.value=true; error.value='';
  try {
    if (!catalog.value.pairs.length) {const value=await read('/training/studio/catalog');if(!alive||token!==epoch)return;catalog.value=value;}
    if (!pairKey.value && catalog.value.pairs[0]) pairKey.value=catalog.value.pairs[0].class_id+':'+catalog.value.pairs[0].subject_id;
    const q=new URLSearchParams({ mode: kind.value==='notes'?'learner':mode.value, q:applied.value });
    if(more && cursor.value)q.set('cursor',cursor.value);
    const data = kind.value==='practice' ? await read('/training/tasks') : await read('/training/studio/'+kind.value+'?'+q);
    if(!alive || token!==epoch)return;
    const items=kind.value==='practice'?data.items.filter((r: Row)=>r.target_type==='coursework'):data.items;
    rows.value=more?[...new Map([...rows.value,...items].map(r=>[r._id,r])).values()]:items; cursor.value=data.next_cursor||null;
    if (detail.value && kind.value!=='notes' && kind.value!=='practice') {const value=await read('/training/studio/'+kind.value+'/'+detail.value._id+(kind.value==='meetups'?'?mode='+mode.value:''));if(!alive||token!==epoch)return;detail.value=value;}
    if (detail.value && kind.value==='notes') detail.value=rows.value.find(r=>r._id===detail.value!._id)||null;
    denied.value=false;
  } catch(e){if(token===epoch){clear();failure(e);}} finally{if(alive && token===epoch)busy.value=false;}
}
async function select(next: typeof kind.value) {
  if(blocked.value)return; if(dirty.value){error.value='请先保存当前内容，再切换学习功能。';return;}
  kind.value=next; mode.value=learner.value?'learner':'staff'; applied.value='';query.value='';resetForm();clear();await load();
}
async function openInitial(){if(!props.initialTarget||blocked.value)return;kind.value='meetups';mode.value='learner';resetForm();clear();await load();await open({_id:props.initialTarget.id});}
watch(()=>props.initialTarget,()=>{void openInitial();});
async function selectMode() { if(dirty.value){error.value='请先保存当前内容。';return;} clear();await load(); }
async function open(row: Row) {
  if (blocked.value || dirty.value) { error.value='请先保存当前内容，再查看其他记录。';return; }
  if(kind.value==='practice'){emit('tasks');return;}
  busy.value=true;error.value='';const token=epoch;
  try { const data = kind.value==='notes'?row:await read('/training/studio/'+kind.value+'/'+row._id+(kind.value==='meetups'?'?mode='+mode.value:''));
    if(!alive||token!==epoch)return;detail.value=data;form.reply='';form.reflection=data.enrollment?.reflection||'';
    if(kind.value==='notes'){form.title=data.title;form.body=data.body;form.due_on=data.due_on||'';form.review_note='';}
    await nextTick(); if(alive&&token===epoch)detailHeading.value?.focus();
  }catch(e){if(token===epoch){detail.value=null;failure(e);}}finally{if(alive&&token===epoch)busy.value=false;}
}
async function save(path: string, body: Row, after?: (r: Row)=>void) {
  if(blocked.value)return;writing.value=true;error.value='';const token=epoch;
  try { const result=await props.write(path,body);if(!alive||token!==epoch||!result)return;
    dirty.value=false;after?.(result);
  }catch(e){if(alive&&token===epoch)failure(e);}finally{if(alive&&token===epoch)writing.value=false;}
  if(alive&&token===epoch&&!dirty.value)await load();
}
async function sourceList(more=false) {
  if(blocked.value || !learner.value)return;busy.value=true;error.value='';const token=epoch;
  try {
    const q=new URLSearchParams({limit:'20'});if(more&&sourceCursor.value)q.set('cursor',sourceCursor.value);
    let path='/training/discovery?'+q;
    if(form.source_kind==='chapter')path='/textbook-editions?'+q;
    if(form.source_kind==='mistake'){if(!pair.value)throw new Error('请先选择班级与学科。');q.set('subject_id',pair.value.subject_id);path='/me/mistakes?'+q;}
    const data=await read(path);if(!alive||token!==epoch)return;sources.value=more?[...sources.value,...data.items]:data.items;sourceCursor.value=data.next_cursor;
    if(!more){units.value=[];form.source_id='';form.lesson_key='';}
  }catch(e){if(token===epoch){sources.value=[];failure(e);}}finally{if(alive&&token===epoch)busy.value=false;}
}
async function sourceUnits(more=false) {
  if(!form.source_id || blocked.value)return;busy.value=true;error.value='';const token=epoch;
  try {
    let path='/training/courses/'+form.source_id+'?mode=learner';
    if(form.source_kind==='chapter')path='/textbook-editions/'+form.source_id+'/chapters?limit=20'+(more&&unitCursor.value?'&cursor='+unitCursor.value:'');
    if(form.source_kind==='mistake'){units.value=[];return;}
    const data=await read(path);if(!alive||token!==epoch)return;
    const items=form.source_kind==='course'?data.lessons:data.items;units.value=more?[...units.value,...items]:items;unitCursor.value=data.next_cursor||null;form.lesson_key='';
  }catch(e){if(token===epoch){units.value=[];failure(e);}}finally{if(alive&&token===epoch)busy.value=false;}
}
async function createNote() {
  if(form.source_kind!=='mistake'&&!form.lesson_key){error.value='请选择具体课节或章节。';return;}
  await save('/training/studio/notes',{title:form.title,body:form.body,source_kind:form.source_kind,
    source_id:form.source_kind==='chapter'?form.lesson_key:form.source_id,lesson_key:form.source_kind==='course'?form.lesson_key:'',due_on:form.due_on||null},()=>{form.title='';form.body='';detail.value=null;});
}
async function noteAction(action: string) {
  if(!detail.value)return;const body: Row={action,expected_revision:detail.value.revision};
  if(action==='review'&&(form.title!==detail.value.title||form.body!==detail.value.body)){error.value='请先保存笔记修改，再记录本次复习。复习草稿会保留。';return;}
  if(action==='edit')Object.assign(body,{title:form.title,body:form.body,due_on:form.due_on||null});
  if(action==='review')Object.assign(body,{note:form.review_note,due_on:form.due_on||null});
  await save('/training/studio/notes/'+detail.value._id+'/actions',body,result=>{
    if(action==='delete'){detail.value=null;form.title='';form.body='';form.review_note='';}
    else {detail.value={...detail.value,...result};if(action==='review')form.review_note='';dirty.value=!!form.review_note;}
  });
}
async function createQuestion() { if(!pair.value)return;await save('/training/studio/questions',{...pairIds(),course_id:null,title:form.title,body:form.body},()=>{form.title='';form.body='';}); }
function pairIds(){return {class_id:pair.value!.class_id,subject_id:pair.value!.subject_id};}
async function questionAction(action: string) { if(!detail.value)return;await save('/training/studio/questions/'+detail.value._id+'/actions',{action,expected_revision:detail.value.revision,...(action==='reply'?{body:form.reply}:{})},()=>{form.reply='';}); }
function iso(value: string){const date=new Date(value);if(!value||!Number.isFinite(date.getTime()))throw new Error('请填写有效的日期和时间。');return date.toISOString();}
async function createMeetup(){if(!pair.value)return;try{await save('/training/studio/meetups',{...pairIds(),title:form.title,body:form.body,location:form.location,starts_at:iso(form.starts_at),ends_at:iso(form.ends_at),enrollment_closes_at:iso(form.closes_at),capacity:form.capacity},()=>{form.title='';form.body='';});}catch(e){failure(e);}}
async function meetupAction(action: string, member?: Row){if(!detail.value)return;await save('/training/studio/meetups/'+detail.value._id+'/actions',{action,expected_revision:detail.value.revision,...(member?{enrollment_id:member._id,enrollment_revision:member.revision}:detail.value.enrollment?{enrollment_revision:detail.value.enrollment.revision}:{}),...(action==='reflect'?{reflection:form.reflection}:{})});}
async function createPractice(){if(!pair.value)return;try{await save('/training/tasks',{...pairIds(),title:form.title,target_type:'coursework',target_id:null,due_at:iso(form.due_at),
  body:`学习目标\n${form.objectives}\n\n实践步骤\n${form.steps}\n\n作品要求\n${form.deliverables}\n\n实践回顾\n说明完成过程、遇到的问题、采用的方法和下一次改进。`,rubric:rubric.value},()=>{form.title='';form.objectives='';form.steps='';form.deliverables='';});}catch(e){failure(e);}}
async function publishPractice(row: Row){await save('/training/tasks/'+row._id+'/actions',{action:'publish',expected_revision:row.revision});}
watch(()=>props.contextKey,()=>{++epoch;controller.abort();controller=new AbortController();clear();catalog.value={pairs:[]};pairKey.value='';query.value='';applied.value='';resetForm();mode.value=learner.value?'learner':'staff';denied.value=false;dirty.value=false;busy.value=false;writing.value=false;void load().then(openInitial);},{immediate:true});
const timer=window.setInterval(()=>{if(!blocked.value&&!denied.value)void load();},30000);
onBeforeUnmount(()=>{alive=false;++epoch;controller.abort();window.clearInterval(timer);clear();emit('dirty',false);});
</script>

<template>
<section class="learning-studio" :aria-busy="blocked" aria-labelledby="studio-heading">
  <div class="studio-heading"><div><h3 id="studio-heading">把所学用起来</h3><p>留下自己的思考，完成作品，向教师提问，与同班学习者共同实践。</p></div><button class="button secondary" :disabled="blocked" @click="load()">刷新学习记录</button></div>
  <nav class="actions" aria-label="实践与协作功能"><button v-for="[key,label] in [['notes','来源笔记'],['practice','作品实践'],['questions','教师答疑'],['meetups','共学活动']]" v-show="key!=='notes'||learner" :key="key" class="button secondary" :aria-pressed="kind===key" :disabled="blocked" @click="select(key as typeof kind)">{{ label }}</button></nav>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="busy" role="status">正在核对当前授权…</p>
  <details v-if="recoveredNotice"><summary>原请求已确认保存</summary><p>可保留当前草稿，或清除本页未保存内容并读取已保存记录。重新读取不会再次提交原请求。</p><button class="button secondary" :disabled="blocked" @click="readConfirmed">确认清除本页草稿并读取已保存记录</button></details>
  <label v-if="catalog.pairs.length">班级与学科<select v-model="pairKey" :disabled="blocked || dirty" @change="sources=[];units=[]"><option v-for="p in catalog.pairs" :key="p.class_id+':'+p.subject_id" :value="p.class_id+':'+p.subject_id">{{ p.class_name }} · {{ p.subject_name }}</option></select></label>
  <p v-if="catalog.truncated">当前显示前200个班级学科安排。</p>
  <label v-if="learner && (kind==='questions'&&canAnswer || kind==='meetups'&&canManage)">查看范围<select v-model="mode" :disabled="blocked || dirty" @change="selectMode"><option value="learner">本人学习</option><option value="staff">授课管理</option></select></label>
  <form v-if="kind!=='practice'" class="actions" role="search" @submit.prevent="load(false,true)"><label>查找标题<input v-model="query" type="search" maxlength="100" :disabled="blocked" /></label><button class="button secondary" :disabled="blocked">查找记录</button></form>
  <div class="studio-grid"><aside aria-label="学习记录"><p v-if="!busy&&!rows.length">暂无记录。</p><article v-for="row in rows" :key="row._id"><h4>{{ row.title }}</h4><p v-if="row.status">{{ labels[row.status] || row.status }}</p><p v-if="kind==='notes'">{{ row.source.title }} · {{ row.due_on ? '下次复习 '+row.due_on : '尚未安排复习' }} · 已复习 {{ row.review_count }} 次</p><p v-if="kind==='meetups'">{{ new Date(row.starts_at).toLocaleString() }} · 已报名 {{ row.enrolled_count }}/{{ row.capacity }}</p><button class="button secondary" :disabled="blocked" @click="open(row)">{{ kind==='practice'?'进入作品提交与评价':'查看详情' }}</button><button v-if="kind==='practice'&&canManage&&row.status==='draft'" class="button" :disabled="blocked" @click="publishPractice(row)">发布实践任务</button></article><button v-if="cursor" class="button secondary" :disabled="blocked" @click="load(true)">继续查找记录</button><p v-if="kind==='practice'">作品使用任务中的草稿、正式提交、附件和教师量规反馈。提交后可按原规则修订，未提交附件仅本人可见。</p></aside>
  <div>
    <template v-if="kind==='notes'">
      <form v-if="!detail" @submit.prevent="createNote" @input="changed" @change="changed"><h4>记录学习笔记</h4><label>来源类型<select v-model="form.source_kind" :disabled="blocked" @change="sources=[];units=[];form.source_id='';form.lesson_key='' "><option value="course">已分配课程</option><option value="chapter">授权教材章节</option><option value="mistake">本人已发布错题</option></select></label>
        <button type="button" class="button secondary" :disabled="blocked" @click="sourceList()">查找可用来源</button>
        <label>选择来源<select v-model="form.source_id" required :disabled="blocked" @change="sourceUnits()"><option value="" disabled>请选择</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.title }}</option></select></label><button v-if="sourceCursor" type="button" class="button secondary" :disabled="blocked" @click="sourceList(true)">继续查找来源</button>
        <label v-if="form.source_kind!=='mistake'">选择课节或章节<select v-model="form.lesson_key" required :disabled="blocked"><option value="" disabled>请选择具体内容</option><option v-for="unit in units" :key="unit.key||unit.id" :value="unit.key||unit.id">{{ unit.title }}</option></select></label><button v-if="unitCursor" type="button" class="button secondary" :disabled="blocked" @click="sourceUnits(true)">继续查找章节</button>
        <label>笔记标题<input v-model="form.title" maxlength="120" required :disabled="blocked" /></label><label>我的理解<textarea v-model="form.body" maxlength="4000" :disabled="blocked" /></label><label>下次复习<input v-model="form.due_on" type="date" :disabled="blocked" /></label><button class="button" :disabled="blocked">保存来源笔记</button>
      </form>
      <form v-else @submit.prevent="noteAction('edit')" @input="changed"><h4 ref="detailHeading" tabindex="-1">回看与复习</h4><p>来源：{{ detail.source.title }}</p><button v-if="detail.source.kind==='chapter'" type="button" class="button secondary" :disabled="blocked||dirty" @click="emit('reading',{editionId:detail.source.edition_id,chapterId:detail.source.id})">回看来源章节</button><p v-if="detail.source_changed" role="status">来源修订已变化，请回看后确认采用当前版本。</p><button v-if="detail.source.kind==='course'" type="button" class="button secondary" :disabled="blocked||dirty" @click="emit('course',detail.source.id)">返回来源课程</button><button v-if="detail.source_changed" type="button" class="button secondary" :disabled="blocked||dirty" @click="noteAction('refresh-source')">确认当前来源版本</button>
        <label>笔记标题<input v-model="form.title" maxlength="120" required :disabled="blocked" /></label><label>我的理解<textarea v-model="form.body" maxlength="4000" :disabled="blocked" /></label><label>下次复习<input v-model="form.due_on" type="date" :disabled="blocked" /></label><button class="button" :disabled="blocked">保存修改</button>
        <label>本次复习收获<textarea v-model="form.review_note" maxlength="1000" :disabled="blocked" /></label><button type="button" class="button secondary" :disabled="blocked" @click="noteAction('review')">记录本次复习与下次日期</button><ol><li v-for="(event,index) in detail.review_history" :key="index">{{ new Date(event.at).toLocaleString() }} · {{ event.note || '已复习' }}</li></ol><details><summary>删除这条笔记</summary><p>确认后笔记正文和历史将清除。</p><button type="button" class="button secondary" :disabled="blocked" @click="noteAction('delete')">确认删除笔记</button></details><button type="button" class="button secondary" :disabled="blocked||dirty" @click="detail=null;form.title='';form.body=''">新建另一条笔记</button>
      </form>
    </template>
    <template v-if="kind==='practice'"><form v-if="canManage&&pair" @submit.prevent="createPractice" @input="changed"><h4>设计作品实践</h4><label>实践名称<input v-model="form.title" required maxlength="200" :disabled="blocked" /></label><label>学习目标<textarea v-model="form.objectives" required maxlength="2000" :disabled="blocked" /></label><label>实践步骤<textarea v-model="form.steps" required maxlength="6000" :disabled="blocked" /></label><label>作品要求<textarea v-model="form.deliverables" required maxlength="4000" :disabled="blocked" /></label><label>提交截止<input v-model="form.due_at" type="datetime-local" required :disabled="blocked" /></label><fieldset :disabled="blocked"><legend>评价量规（权重合计100）</legend><div v-for="(dimension,index) in rubric" :key="dimension.key" class="rubric"><label>维度 {{ index+1 }}<input v-model="dimension.title" required maxlength="200" /></label><label>权重<input v-model.number="dimension.weight" type="number" required min="0" max="100" /></label></div></fieldset><button class="button" :disabled="blocked">保存实践草稿</button></form><p v-else>从实践任务进入，提交作品与过程记录，再查看教师评价和改进建议。</p></template>
    <template v-if="kind==='questions'"><form v-if="learner&&mode==='learner'&&!detail&&pair" @submit.prevent="createQuestion" @input="changed"><h4>向本班授课教师提问</h4><label>问题标题<input v-model="form.title" required maxlength="200" :disabled="blocked" /></label><label>问题与已尝试的方法<textarea v-model="form.body" required maxlength="4000" :disabled="blocked" /></label><button class="button" :disabled="blocked">提交问题</button><p>问题和回复仅本人及当前授课教师可见。</p></form>
      <article v-if="detail"><h4 ref="detailHeading" tabindex="-1">{{ detail.title }}</h4><p v-if="detail.work_context">此问题关联具体作品版本。</p><button v-if="detail.work_context" :disabled="blocked||dirty" @click="emit('work',detail.work_context.task_id)">查看关联作品与附件</button><p class="body">{{ detail.body }}</p><ol><li v-for="message in detail.messages" :key="message._id"><strong>{{ message.role==='teacher'?'授课教师':'学习者' }}</strong><p class="body">{{ message.body }}</p></li></ol><form v-if="detail.status!=='closed'" @submit.prevent="questionAction('reply')" @input="changed"><label>{{ mode==='staff'?'教师答复':'补充与追问' }}<textarea v-model="form.reply" required maxlength="4000" :disabled="blocked" /></label><button class="button" :disabled="blocked">发送{{ mode==='staff'?'答复':'追问' }}</button></form><div class="actions"><button class="button secondary" :disabled="blocked||dirty" @click="questionAction(detail.status==='closed'?'reopen':'close')">{{ detail.status==='closed'?'重新打开问题':'标记已解决' }}</button><button class="button secondary" :disabled="blocked||dirty" @click="detail=null">返回问题列表</button></div></article>
    </template>
    <template v-if="kind==='meetups'"><form v-if="canManage&&mode==='staff'&&!detail&&pair" @submit.prevent="createMeetup" @input="changed"><h4>组织共学活动</h4><label>活动名称<input v-model="form.title" required maxlength="200" :disabled="blocked" /></label><label>共学安排与参与要求<textarea v-model="form.body" required maxlength="4000" :disabled="blocked" /></label><label>活动地点<input v-model="form.location" required maxlength="200" :disabled="blocked" /></label><label>报名截止<input v-model="form.closes_at" type="datetime-local" required :disabled="blocked" /></label><label>开始时间<input v-model="form.starts_at" type="datetime-local" required :disabled="blocked" /></label><label>结束时间<input v-model="form.ends_at" type="datetime-local" required :disabled="blocked" /></label><label>名额<input v-model.number="form.capacity" type="number" min="1" max="200" required :disabled="blocked" /></label><button class="button" :disabled="blocked">保存活动草稿</button></form>
      <article v-if="detail"><h4 ref="detailHeading" tabindex="-1">{{ detail.title }}</h4><p class="body">{{ detail.body }}</p><p>{{ detail.location }} · {{ new Date(detail.starts_at).toLocaleString() }} 至 {{ new Date(detail.ends_at).toLocaleString() }}</p><p>报名及取消截止：{{ new Date(detail.enrollment_closes_at).toLocaleString() }}</p><p>{{ labels[detail.status] }} · 已报名 {{ detail.enrolled_count }}/{{ detail.capacity }}</p><div class="actions"><button v-if="mode==='staff'&&detail.status==='draft'" class="button" :disabled="blocked" @click="meetupAction('publish')">发布共学活动</button><button v-if="mode==='staff'&&detail.status==='published'&&new Date(detail.ends_at).getTime()<=Date.now()" class="button secondary" :disabled="blocked" @click="meetupAction('complete')">结束活动</button><button v-if="mode==='learner'&&detail.status==='published'&&(!detail.enrollment||detail.enrollment.status==='cancelled')" class="button" :disabled="blocked||detail.enrolled_count>=detail.capacity||new Date(detail.enrollment_closes_at).getTime()<=Date.now()" @click="meetupAction('enroll')">报名参加</button><button v-if="mode==='learner'&&detail.enrollment?.status==='enrolled'&&detail.status==='published'" class="button secondary" :disabled="blocked||new Date(detail.enrollment_closes_at).getTime()<=Date.now()" @click="meetupAction('withdraw')">取消本人报名</button></div><p v-if="detail.enrollment">我的参与：{{ labels[detail.enrollment.status] }}</p>
        <div v-if="mode==='staff'"><h5>参与确认</h5><article v-for="member in detail.members" :key="member._id"><p>{{ member.name }} · {{ labels[member.status] }}</p><p class="body">{{ member.reflection }}</p><div class="actions"><button v-for="state in ['attended','absent']" :key="state" class="button secondary" :disabled="blocked||!['published','completed'].includes(detail.status)||new Date(detail.starts_at).getTime()>Date.now()" @click="meetupAction(state,member)">记录{{ labels[state] }}</button></div></article><details v-if="['draft','published'].includes(detail.status)"><summary>取消活动</summary><p>取消后停止报名与参与写入。</p><button class="button secondary" :disabled="blocked" @click="meetupAction('cancel')">确认取消活动</button></details></div>
        <form v-if="mode==='learner'&&detail.enrollment?.status==='attended'&&['published','completed'].includes(detail.status)" @submit.prevent="meetupAction('reflect')" @input="changed"><label>共学实践回顾<textarea v-model="form.reflection" required maxlength="2000" :disabled="blocked" /></label><button class="button" :disabled="blocked">保存参与回顾</button></form><button class="button secondary" :disabled="blocked||dirty" @click="detail=null">返回活动列表</button>
      </article><p v-else-if="mode==='learner'">在班级内选择活动报名，按安排参加，由授课教师确认参与后记录自己的收获。</p>
    </template>
  </div></div>
</section>
</template>
<style scoped>
.learning-studio{padding:1rem 0;min-width:0;overflow-wrap:anywhere}.studio-heading{display:flex;justify-content:space-between;gap:1rem}.studio-grid{display:grid;grid-template-columns:minmax(180px,1fr) minmax(0,2fr);gap:1.5rem;margin-top:1rem}.learning-studio article{padding:1rem;border:1px solid #c8d9e7;border-radius:12px;margin-bottom:1rem;min-width:0}.learning-studio form,.learning-studio label{display:grid;gap:.6rem;min-width:0}.learning-studio form{gap:1rem}.learning-studio input,.learning-studio textarea,.learning-studio select{box-sizing:border-box;min-width:0;width:100%;max-width:100%;min-height:44px;font:inherit;padding:.6rem}.learning-studio textarea{min-height:100px}.learning-studio .actions{display:flex;flex-wrap:wrap;gap:.6rem;align-items:end;margin:.8rem 0}.learning-studio button,.learning-studio summary{min-height:44px;max-width:100%;white-space:normal}.learning-studio .body{white-space:pre-wrap}.rubric{display:grid;grid-template-columns:minmax(0,2fr) minmax(60px,1fr);gap:.5rem}fieldset{min-width:0}.learning-studio ol{padding-left:1.2rem}.learning-studio aside article h4{margin-top:0}@media(max-width:700px){.studio-grid{grid-template-columns:minmax(0,1fr)}.studio-heading{flex-direction:column}}
</style>
