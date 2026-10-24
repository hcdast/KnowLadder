<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ApiError,type BusinessRequest} from '../session';
import type {paths} from '../api/schema';
type Page=paths['/api/v1/training/discovery/paths']['get']['responses'][200]['content']['application/json']['data'];
type Detail=paths['/api/v1/training/discovery/paths/{id}']['get']['responses'][200]['content']['application/json']['data'];
const props=defineProps<{request:BusinessRequest;contextKey:string}>();
const emit=defineEmits<{course:[id:string];tasks:[];phase2:[]}>();
const rows=ref<Page['items']>([]),detail=ref<Detail|null>(null),cursor=ref<string|null>(null);
const busy=ref(false),error=ref(''),loaded=ref(false),denied=ref(false);
const detailHeading=ref<HTMLHeadingElement>();
const filters=reactive({q:'',sort:'newest'}),applied=ref({...filters});
const unapplied=computed(()=>filters.q!==applied.value.q||filters.sort!==applied.value.sort);
let epoch=0,controller=new AbortController(),timer=0;
function clearPrivate(){rows.value=[];detail.value=null;cursor.value=null;loaded.value=false;}
function failure(e:unknown){clearPrivate();denied.value=e instanceof ApiError&&[401,403,404].includes(e.status);error.value=denied.value?'路径或学习权限已变化，请重新核对当前目录。':e instanceof Error?e.message:'路径读取失败，请重试。';}
async function load(more=false,apply=false){
 if(apply)applied.value={...filters};const token=++epoch;controller.abort();controller=new AbortController();
 if(!more){rows.value=[];cursor.value=null;}detail.value=null;busy.value=true;error.value='';loaded.value=false;
 const q=new URLSearchParams();if(applied.value.q)q.set('q',applied.value.q);if(applied.value.sort!=='newest')q.set('sort',applied.value.sort);if(more&&cursor.value)q.set('cursor',cursor.value);
 try{const page=await props.request<Page>('/training/discovery/paths'+(q.size?'?'+q:''),{signal:controller.signal});if(token!==epoch)return;
 rows.value=[...new Map([...(more?rows.value:[]),...page.items].map(x=>[x.id,x])).values()];cursor.value=page.next_cursor;loaded.value=true;denied.value=false;
 }catch(e){if(token===epoch)failure(e);}finally{if(token===epoch)busy.value=false;}
}
async function open(id:string,moveFocus=true){
 const token=++epoch;controller.abort();controller=new AbortController();detail.value=null;busy.value=true;error.value='';
 try{const data=await props.request<Detail>('/training/discovery/paths/'+id,{signal:controller.signal});if(token!==epoch)return;detail.value=data;denied.value=false;
 if(moveFocus){await nextTick();if(token===epoch)detailHeading.value?.focus();}
 }catch(e){if(token===epoch)failure(e);}finally{if(token===epoch)busy.value=false;}
}
function reset(){Object.assign(filters,{q:'',sort:'newest'});void load(false,true);}
watch(()=>props.contextKey,()=>{clearPrivate();reset();},{immediate:true,flush:'sync'});
timer=window.setInterval(()=>{if(!busy.value&&!denied.value){if(detail.value)void open(detail.value.id,false);else void load();}},30000);
onBeforeUnmount(()=>{++epoch;controller.abort();clearInterval(timer);clearPrivate();});
</script>
<template>
<section class="learning-paths" aria-labelledby="learner-path-title" :aria-busy="busy">
 <div class="path-heading"><div><h3 id="learner-path-title">我的学习路径</h3><p>查看机构已指派给你的学习组合，按路径了解课程顺序，再进入学习。</p></div><button class="button secondary" :disabled="busy" @click="load()">刷新路径</button></div>
 <form role="search" aria-label="查找本人学习路径" class="path-filters" @submit.prevent="load(false,true)">
  <label>路径名称<input v-model="filters.q" type="search" maxlength="100" :disabled="busy" placeholder="输入路径名称" /></label>
  <label>路径排序<select v-model="filters.sort" :disabled="busy"><option value="newest">最近指派在前</option><option value="oldest">较早指派在前</option></select></label>
  <div class="actions"><button class="button" :disabled="busy">查找路径</button><button class="button secondary" type="button" :disabled="busy" @click="reset">清除路径筛选</button></div>
 </form>
 <p v-if="unapplied" role="status">路径筛选尚未应用，继续查找仍使用上次条件。</p>
 <p v-if="busy" role="status">正在核对路径与学习来源…</p><p v-else-if="error" role="alert">{{error}}</p>
 <template v-else-if="loaded">
  <p v-if="!rows.length" role="status">{{cursor?'这一批没有当前可用路径，可继续查找后续指派。':'暂无匹配的本人学习路径，可清除条件或联系教师确认安排。'}}</p>
  <p v-else role="status">已加载 {{rows.length}} 条本人路径{{cursor?'，还有后续指派可查找。':'，本次查找已结束。'}}</p>
  <div class="path-grid"><article v-for="row in rows" :key="row.id"><h4>{{row.title}}</h4><p>{{row.course_count}} 门课程 · {{row.task_count}} 项成绩任务</p><p>发布快照修订 {{row.path_revision}} · 指派于 {{row.assigned_at.slice(0,10)}}</p><button class="button secondary" @click="open(row.id)">查看路径《{{row.title}}》</button></article></div>
  <button v-if="cursor" class="button secondary" @click="load(true)">继续查找路径</button>
 </template>
 <section v-if="detail" class="path-detail" aria-label="本人路径详情"><div class="path-heading"><h4 ref="detailHeading" tabindex="-1">{{detail.title}}</h4><button class="button secondary" @click="open(detail.id)">刷新路径进度</button></div>
  <p>发布快照修订 {{detail.path_revision}}。按指派顺序呈现，课程入口会再次核对当前权限。</p>
  <ol><li v-for="course in detail.courses" :key="course.id"><h5>{{course.title}}</h5><p>课程版本 {{course.version_no}} · {{course.lesson_count}} 个课节 · 必修已确认 {{course.confirmed_required_count}} / {{course.required_lesson_count}}</p><button class="button" @click="emit('course',course.id)">{{course.required_lesson_count>0&&course.confirmed_required_count===course.required_lesson_count?'回看':'学习'}}《{{course.title}}》</button></li></ol>
  <p>结业规则：到场课时比例至少 {{detail.attendance_bp/100}}%；{{detail.task_count}} 项成绩任务，成绩要求 {{detail.grade_min}} 分。实际资格仍由原教务规则核对。</p>
  <p>课节确认表示学习记录，不代表知识掌握、已结业或已获得证书。路径呈现顺序不新增强制先修限制。</p>
  <div class="actions"><button v-if="detail.task_count" class="button secondary" @click="emit('tasks')">查看任务与作业</button><button class="button secondary" @click="emit('phase2')">查看课表与结业</button></div>
 </section>
 <p class="muted">只展示本人当前有效的指派；课程来源、分配或媒体失效时停止展示详情。路径与详情会定期重新核对，已加载数量不代表全站总量。</p>
</section>
</template>
<style scoped>
.learning-paths{margin-top:2rem;border-top:1px solid #c8d9e7;padding-top:1rem;overflow-wrap:anywhere}.path-heading{display:flex;justify-content:space-between;gap:1rem;align-items:start}.path-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem;margin:1rem 0}label{display:grid;gap:.5rem;min-width:0}input,select{min-width:0;width:100%;box-sizing:border-box;font:inherit;padding:.6rem;min-height:44px}.path-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;margin-bottom:1rem}article,.path-detail{border:1px solid #c8d9e7;border-radius:12px;padding:1rem}h4,h5{font-size:1.1rem;margin:.7rem 0}p{line-height:1.7}.path-detail{margin-top:1rem}.path-detail ol{padding-left:1.5rem}.path-detail li{padding:.5rem 0 1rem}.learning-paths button{min-height:44px;max-width:100%;white-space:normal}.actions{display:flex;gap:.6rem;flex-wrap:wrap}.muted{color:#47647b}@media(max-width:850px){.path-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.path-grid,.path-filters{grid-template-columns:1fr}.path-heading{flex-direction:column}}
</style>
