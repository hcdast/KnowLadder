'use strict';
const {guardedUri}=require('./helpers.cjs');const {listenTestHttp}=require('./http-listen.cjs');
(async()=>{let app;try{guardedUri(process.env.MONGODB_URI);app=await require('../dist/app').createApp();const base=await listenTestHttp(app);process.send({ready:true,base,pid:process.pid});await new Promise(r=>{process.on('message',m=>{if(m.stop)r();});process.once('disconnect',r);process.once('SIGTERM',r);});}catch{process.send?.({error:'ISOLATED_API_FAILED'});process.exitCode=1;}finally{await app?.close();if(process.connected)process.disconnect();}})();
