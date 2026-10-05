import { objectIdDatabase } from "../database/object-id";
import { newId } from "../database/object-id";
import { MongoClient } from 'mongodb';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config';
import { assertSchema } from '../migrations/schema';
import { object, text, id } from './dto';
import { acquireWriter, assertOperationalAccess, type WriterRegistration } from '../operations/control';
import { runInTxn } from '../database/txn';
export async function runCatalogue(argv=process.argv.slice(2)) {
  const flags:Record<string,string>={};
  for(let index=0;index<argv.length;index+=2){const flag=argv[index];if(!['--file','--actor','--reason'].includes(flag)||flags[flag]!==undefined||!argv[index+1])throw Error('用法: catalogue-cli --file 绝对JSON路径 --actor 操作者 --reason 导入原因');flags[flag]=argv[index+1];}
  const actor=text(flags['--actor'],'actor',200);const reason=text(flags['--reason'],'reason',1000);const path=text(flags['--file'],'file',4096);if(!isAbsolute(path))throw Error('目录文件必须为绝对路径');
  const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let raw:unknown;
  try {const stat=await handle.stat();if(!stat.isFile()||stat.size>2*1024*1024)throw Error('仅接受不超过2MiB的普通JSON文件');const bytes=Buffer.alloc(Number(stat.size)+1);const {bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead!==stat.size)throw Error('目录文件在读取时发生变化');raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));}finally{await handle.close();}
  const payload=object(raw,['education_stages','subjects','knowledge_points']);
  const groups:Record<string,Record<string,unknown>[]>={};
  for(const name of ['education_stages','subjects','knowledge_points']){const values=payload[name]??[];if(!Array.isArray(values)||values.length>10000)throw Error(`${name}最多10000条`);groups[name]=values.map(value=>{const item=object(value,name==='knowledge_points'?['id','code','name','subject_id']:['id','code','name']);const code=text(item.code,'code',64);if(!/^[A-Za-z0-9_.-]+$/.test(code))throw Error('code仅允许字母数字_.-');return {_id:id(item.id),code,name:text(item.name,'name'),...(name==='knowledge_points'?{subject_id:id(item.subject_id)}:{})};});if(new Set(groups[name].map(v=>v._id)).size!==groups[name].length||new Set(groups[name].map(v=>v.code)).size!==groups[name].length)throw Error(`${name}的id/code重复`);}
  if(!Object.values(groups).some(values=>values.length))throw Error('导入内容不能为空');
  const client=new MongoClient(loadConfig().mongoUri);
  let writer: WriterRegistration | undefined;
  try {
    await client.connect();
    const db=objectIdDatabase(client.db());
    await assertSchema(db);
    writer=await acquireWriter(db,'catalogue');
    await runInTxn(client, async (session) => {
      await assertOperationalAccess(db);
      for(const [name,items] of Object.entries(groups)) {
        for(const item of items) {
          if(name==='knowledge_points'&&!await db.collection('subjects').findOne({_id:item.subject_id} as never,{session}))throw Error('知识点学科不存在');
          const existing=await db.collection(name).findOne({_id:item._id} as never,{session});
          if(existing) {
            if(existing.code!==item.code||existing.name!==item.name||(name==='knowledge_points'&&existing.subject_id!==item.subject_id))throw Error('目录id已存在且内容不同；目录导入不可变');
            continue;
          }
          const now=new Date();
          await db.collection(name).insertOne({...item,created_at:now,updated_at:now},{session});
          await db.collection('audit_events').insertOne({_id:newId(),actor_id:actor,org_id:null,action:`catalogue.${name}.create`,resource_id:item._id,reason,request_id:randomUUID(),created_at:now} as never,{session});
        }
      }
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
    process.stdout.write(JSON.stringify({imported:Object.fromEntries(Object.entries(groups).map(([key,values])=>[key,values.length]))})+'\n');
  } finally {
    try { await writer?.release(); }
    finally { await client.close(); }
  }
}
if(require.main===module)runCatalogue().catch(error=>{process.stderr.write((error instanceof Error?error.message:'目录导入失败')+'\n');process.exitCode=1;});
