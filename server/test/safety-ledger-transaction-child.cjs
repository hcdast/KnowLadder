"use strict";
const { MongoClient } = require('mongodb');
const { once } = require('node:events');
const { guardedUri } = require('./helpers.cjs');
(async()=>{
  const client=new MongoClient(guardedUri(process.env.TEST_LEDGER_SOURCE_URI),{appName:process.env.TEST_LEDGER_APP_NAME});
  await client.connect(); const session=client.startSession();
  try {
    session.startTransaction({readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true}});
    await client.db().collection('question_versions').updateOne({_id:process.env.TEST_LEDGER_RESOURCE_ID},{$set:{access_revoked_at:new Date()},$inc:{access_revision:1}},{session});
    process.send({type:'staged'});
    await once(process,'message');
    await session.commitTransaction();
    process.send({type:'committed'});
  } finally { await session.endSession(); await client.close(); }
})().then(()=>process.exit(0),()=>process.exit(1));
