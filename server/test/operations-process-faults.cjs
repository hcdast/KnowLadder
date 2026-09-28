"use strict";
const assert=require("node:assert/strict");
const {MongoClient}=require("mongodb");

// Real server-side hold, not a JavaScript callback or simulated process failure.
// The managed child first commits its mutex acquisition, then blocks its next
// control-head update. The supervisor has a different appName and can clear the
// owned mutex after observing the actual child exit.
async function openManagedLedgerPublishBarrier(controlUri) {
  const control=new MongoClient(controlUri,{serverSelectionTimeoutMS:10000});
  assert.match(control.db().databaseName,/^kl_control_[A-Za-z0-9_-]+$/);
  assert.ok(control.options.hosts.length>0&&control.options.hosts.every(host=>["127.0.0.1","localhost","::1"].includes(host.host)));
  let direct,configured=false;
  try {
    await control.connect();const hello=await control.db("admin").command({hello:1});
    assert.ok(hello.setName);assert.match(hello.primary,/^(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/);
    direct=new MongoClient(`mongodb://${hello.primary}/admin?directConnection=true`,{serverSelectionTimeoutMS:10000});await direct.connect();
    const admin=direct.db("admin");
    const point=await admin.command({configureFailPoint:"failCommand",mode:{skip:1},data:{appName:"knowladder-ledger-managed",failCommands:["update"],blockConnection:true,blockTimeMS:120000}});configured=true;
    return {
      async waitUntilBlocked(environmentId) {
        await admin.command({waitForFailPoint:"failCommand",timesEntered:point.count+1,maxTimeMS:60000});
        const head=await control.db().collection("safety_ledger_heads").findOne({_id:environmentId});
        assert.ok(head&&typeof head.lock==="string"&&typeof head.ownerLaunchToken==="string","real child must own committed mutex before interruption");
        return {generation:head.generation,sequence:head.sequence};
      },
      async close() {
        try {if(configured) {await admin.command({configureFailPoint:"failCommand",mode:"off"});configured=false;}}
        finally {await direct.close();await control.close();}
      },
    };
  } catch(error) {
    try {if(configured) await direct.db("admin").command({configureFailPoint:"failCommand",mode:"off"});}
    finally {await direct?.close();await control.close();}
    throw error;
  }
}
module.exports={openManagedLedgerPublishBarrier};
