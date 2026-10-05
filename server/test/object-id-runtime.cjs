"use strict";
const {MongoMemoryServer,MongoMemoryReplSet}=require("mongodb-memory-server-core");
const {spawn}=require("node:child_process");
(async()=>{
 let rs,standalone;
 try {
  const binary={version:"8.0.17",...(process.env.TEST_MONGOD_BINARY?{systemBinary:process.env.TEST_MONGOD_BINARY}:{})};
  rs=await MongoMemoryReplSet.create({binary,replSet:{count:1,storageEngine:"wiredTiger"},instanceOpts:[{launchTimeout:30000,args:["--wiredTigerCacheSizeGB","0.25","--setParameter","enableTestCommands=1"]}]});
  standalone=await MongoMemoryServer.create({binary,instance:{launchTimeout:30000,args:["--wiredTigerCacheSizeGB","0.25"]}});
  const files=process.argv.slice(2);
  const child=spawn(process.execPath,["--test","--test-reporter=tap","--test-concurrency=1",...(process.env.KL_TEST_PATTERN ? ["--test-name-pattern="+process.env.KL_TEST_PATTERN] : []),...(files.length?files:["test/object-id.integration.test.cjs"])],{cwd:require("node:path").resolve(__dirname,".."),stdio:"inherit",windowsHide:true,env:{...process.env,TEST_MONGODB_URI:rs.getUri("kl_test_oid"),TEST_STANDALONE_MONGODB_URI:standalone.getUri("kl_test_oid"),...(process.platform==="win32"?{PSModulePath:process.env.SystemRoot+"/System32/WindowsPowerShell/v1.0/Modules"}:{}), FILE_SCAN_ENABLED:"false"}});
  process.exitCode=await new Promise(resolve=>child.on("exit",code=>resolve(code??1)));
 }catch(error){console.error(error);process.exitCode=1;}
 finally{await standalone?.stop();await rs?.stop();}
})();
