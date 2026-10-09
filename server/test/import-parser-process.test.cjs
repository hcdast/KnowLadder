const {test}=require('node:test');
const assert=require('node:assert/strict');
const cp=require('node:child_process');
const path=require('node:path');
const {once}=require('node:events');
// Substitute only parser work, preserving the real fork/IPC/kill/timer supervisor.
for(const mode of ['stall','exit','malformed']) test('解析真实子进程监管：'+mode,{timeout:40000},async()=>{
  const original=cp.fork; let child, exited, options;
  cp.fork=function(module,args,opts){
    options=opts;
    child=original(path.join(__dirname,'import-parser-probe-child.cjs'),[mode],opts);
    exited=once(child,'exit');
    return child;
  };
  const start=performance.now();
  try{
    const {extractInProcess}=require('../dist/training/import-parser-process');
    await assert.rejects(extractInProcess(Buffer.from('original synthetic bytes'),'application/pdf'),
      mode==='stall'?/IMPORT_PARSER_TIMEOUT/:mode==='exit'?/IMPORT_PARSER_INTERRUPTED/:/IMPORT_PARSER_FAILED/);
    await exited;
    assert.notEqual(child.exitCode===null&&child.signalCode===null,true);
    assert.equal(options.windowsHide,true);
    assert.deepEqual(options.execArgv,['--max-old-space-size=256']);
    assert.ok(Object.keys(options.env).every(k=>['SystemRoot','NODE_ENV'].includes(k)));
    if(mode==='stall') assert.ok(performance.now()-start>=29000,'production 30s deadline retained');
  }finally{
    cp.fork=original;
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  }
});
test('真实解析模块：输入前父IPC断开后子进程退出',{timeout:10000},async()=>{
  const child=cp.fork(require.resolve('../dist/training/import-parser-process'),['--parse'],{
    execArgv:['--max-old-space-size=256'],env:{...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),NODE_ENV:'production'},
    stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,
  });
  const exited=once(child,'exit'); let timer;
  try{
    await once(child,'spawn'); child.disconnect();
    const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('parser did not exit after IPC disconnect')),5000);})]);
    assert.equal(result[0],0);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});