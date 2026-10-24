import { createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import WeekPlanner from "../src/personal/WeekPlanner.vue";
import { ApiError, type GlobalRequest } from "../src/session";
const stage = document.querySelector<HTMLElement>("#stage")!, output = document.querySelector<HTMLElement>("#results")!;
const results: { name: string; passed: boolean; message?: string }[] = [];
const item = { id:"111111111111111111111111", title:"观察与阅读", note:"私人安排", kind:"reading", scheduled_on:"2026-10-15", planned_minutes:20, source_kind:"none", source_id:null, source_version:null, unit_id:null, source_title:null, source_available:true, state:"planned", completion_note:"", completed_on:null, evidence:"self_reported", revision:1 };
const overview = {week_start:"2026-10-12",week_end:"2026-10-18",as_of:"2026-10-15",total:1,completed:0,paused:0,cancelled:0,overdue:0,planned_minutes:20,truncated:false,review:null};
function assert(value: unknown, message: string): asserts value { if(!value)throw Error(message); }
async function settle(){for(let i=0;i<35;i++){await Promise.resolve();await nextTick();}}
function button(name:string){const b=[...stage.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.trim()===name);assert(b,`缺少按钮:${name}`);return b;}
async function click(name:string){const b=button(name);assert(!b.disabled,`按钮不可用:${name}`);b.click();await settle();}
function field(label:string,value:string){const e=[...stage.querySelectorAll("label")].find(l=>l.firstChild?.textContent?.trim()===label)?.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>("input,textarea,select");assert(e,`缺少字段:${label}`);e.value=value;e.dispatchEvent(new Event(e instanceof HTMLSelectElement?"change":"input",{bubbles:true}));}
async function mount(options:{read?:(path:string)=>unknown;write?:(path:string,body:any)=>unknown}={}){
  const calls:{path:string;body?:any;method?:string}[]=[],dirty=ref(false),component=ref<InstanceType<typeof WeekPlanner>>();
  const router=createRouter({history:createMemoryHistory(),routes:[{path:"/personal",component:{render:()=>null}}]});await router.push("/personal?tab=plan");
  const request:GlobalRequest=async<T>(path:string)=>{calls.push({path});const custom=options.read?.(path);if(custom!==undefined)return await custom as T;
    if(path.startsWith("/personal/agenda?"))return {items:[item],next_cursor:null} as T;
    if(path.startsWith("/personal/week-overview?"))return structuredClone(overview) as T;
    if(path.startsWith("/personal/goals?"))return {items:[{id:"222222222222222222222222",title:"本人的目标"}],next_cursor:null} as T;
    if(path.startsWith("/personal/study-items?"))return {items:[],next_cursor:null} as T;
    if(path==="/personal/courses")return {items:[{id:"original",title:"原创观察课",version:2}]} as T;
    if(path==="/personal/courses/original")return {id:"original",version:2,units:[{id:"first",title:"第一次观察"}]} as T;
    throw Error(path);
  };
  const app=createApp({render:()=>h(WeekPlanner,{ref:component,request,locked:false,mode:"week",onDirty:v=>dirty.value=v,write:async(path,body,method)=>{calls.push({path,body,method});const custom=options.write?.(path,body);if(custom!==undefined)return await custom as any;return {operation_id:item.id,resource_id:item.id,revision:2};}})}).use(router);
  app.mount(stage);await settle();return {app,calls,dirty,component};
}
async function run(name:string,work:()=>Promise<void>){try{await work();results.push({name,passed:true});}catch(cause){results.push({name,passed:false,message:cause instanceof Error?cause.message:String(cause)});}finally{stage.replaceChildren();}}
await run("跨课程计划：来源名称选择、当前版本/单元、完整写入",async()=>{
  const f=await mount();try{field("安排标题","计划阅读单元");field("关联来源","course");await settle();field("选择来源","original");await settle();assert(stage.textContent?.includes("第一次观察"),"单元未载入");await click("保存安排");const call=f.calls.find(c=>c.body?.title==="计划阅读单元");assert(call?.path==="/personal/agenda"&&call.body.source_version===2&&call.body.unit_id==="first","没有绑定当前来源");assert(!f.dirty.value,"保存后草稿未清理");}finally{f.app.unmount();}
});
await run("周回顾与安排草稿独立，保存安排不清周回顾；有草稿阻止切周",async()=>{
  const f=await mount();try{field("本周收获","保留周回顾草稿");field("安排标题","并行编辑的安排");await settle();assert(button("下一周").disabled,"草稿时允许切周");await click("保存安排");assert((stage.querySelectorAll("textarea")[1] as HTMLTextAreaElement).value==="保留周回顾草稿","安排保存清除了周回顾");assert(f.dirty.value,"周回顾草稿未保护");await click("保存周回顾");const call=f.calls.find(c=>c.path==="/personal/week-reviews"&&c.body);assert(call?.body.revision===0&&call.body.highlights==="保留周回顾草稿","回顾缺少CAS或正文");}finally{f.app.unmount();}
});
await run("周回顾草稿保留读取时修订，刷新不能掩盖另一窗口的更新冲突",async()=>{
  let revision=1;const f=await mount({read:path=>path.startsWith("/personal/week-overview?")?{...overview,review:{id:item.id,week_start:overview.week_start,highlights:"原回顾",challenges:"",adjustment:"",revision}}:undefined});
  try{field("本周收获","当前窗口草稿");await settle();revision=2;await f.component.value?.refresh();await settle();await click("保存周回顾");const call=f.calls.find(c=>c.path==="/personal/week-reviews"&&c.body);assert(call?.body.revision===1&&call.body.highlights==="当前窗口草稿","刷新以新修订号覆盖了未保存草稿的来源版本");}finally{f.app.unmount();}
});
await run("完成安排为本人记录，暂停与完成不提交课程成绩",async()=>{
  const f=await mount();try{await click("暂停");assert(f.calls.some(c=>c.body?.state==="paused"),"暂停未发送");await click("记录完成");field("完成收获","完成观察，但还需系统阅读");await settle();await click("保存完成记录");const call=f.calls.find(c=>c.body?.state==="completed");assert(call?.body.note.includes("系统阅读")&&call.body.completed_on,"完成说明/日期缺失");assert(!f.calls.some(c=>/\/complete$/.test(c.path)),"计划误写课程完成");}finally{f.app.unmount();}
});
await run("未知写入保留安排草稿，不在组件内自动重发",async()=>{
  let count=0;const f=await mount({write:()=>{count++;return Promise.resolve(undefined);}});try{field("安排标题","网络不确定时的草稿");await settle();await click("保存安排");assert(f.dirty.value&&count===1,"未知结果丢草稿或重复写");assert((stage.querySelector('input[maxlength="120"]') as HTMLInputElement).value==="网络不确定时的草稿","正文丢失");}finally{f.app.unmount();}
});
await run("403清私人安排与草稿、阻止写入；显式刷新可恢复",async()=>{
  let denied=false;const f=await mount({read:path=>{if(denied&&path.startsWith("/personal/agenda?"))throw new ApiError(403,"FORBIDDEN","当前不可访问");}});try{field("安排标题","不应残留的草稿");await settle();denied=true;await f.component.value?.refresh();await settle();assert(!stage.textContent?.includes("私人安排")&&!f.dirty.value,"权限失败残留私有数据");assert(button("保存安排").disabled,"失败后仍可写");denied=false;await click("刷新周计划");assert(stage.textContent?.includes("私人安排"),"显式刷新未恢复");}finally{f.app.unmount();}
});
await run("分页与切周使用选定周，卸载清dirty",async()=>{
  let pages=0;const f=await mount({read:path=>{if(path.startsWith("/personal/agenda?")){pages++;return {items:[item],next_cursor:pages===1?"next-page":null};}}});try{await click("加载更多安排");assert(f.calls.some(c=>c.path.includes("cursor=next-page")),"分页未传游标");await click("下一周");assert(f.calls.filter(c=>c.path.startsWith("/personal/agenda?")).at(-1)?.path.includes("week_start="),"切周未请求对应范围");const selectedWeek=(stage.querySelector('input[type="date"]') as HTMLInputElement).value;const planned=[...stage.querySelectorAll("label")].find(l=>l.firstChild?.textContent?.trim()==="安排日期")?.querySelector("input");assert(planned?.value===selectedWeek,"切周后新增日期未落在所选周");field("安排标题","卸载前草稿");await settle();assert(f.dirty.value,"未上报dirty");}finally{f.app.unmount();}assert(!f.dirty.value,"卸载残留dirty");
});
output.textContent=JSON.stringify({passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results},null,2);output.dataset.complete="true";
