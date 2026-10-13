"use strict";
// Real loopback TLS receiver for isolated SMTP behavior tests, never a production transport.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const tls=require('node:tls');
const {spawn}=require('node:child_process');
const {randomBytes}=require('node:crypto');
async function createTlsSmtpFixture({openssl=process.env.TEST_OPENSSL_BIN||'openssl'}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kl-auth-smtp-'));
 const keyPath=path.join(dir,'key.pem'),caPath=path.join(dir,'cert.pem');
 await new Promise((resolve,reject)=>{const child=spawn(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',keyPath,'-out',caPath],{stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('SMTP_TEST_CERTIFICATE_FAILED')));});
 const user='fixture-'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('base64url'),from='auth-test@example.invalid';
 const messages=[],sockets=new Set();let closing=false,nextAuthenticationHold=null;
 const server=tls.createServer({key:await fs.readFile(keyPath),cert:await fs.readFile(caPath)},socket=>{
  sockets.add(socket);socket.setEncoding('utf8');socket.setTimeout(30000,()=>socket.destroy());socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  let buffer='',authenticated=false,authPending=false,inData=false,dataLines=[],to=[];
  const send=line=>{if(!socket.destroyed)socket.write(line+'\r\n');};
  const auth=value=>{let parts;try{parts=Buffer.from(value,'base64').toString('utf8').split('\0');}catch{}const allowed=!!parts&&parts[1]===user&&parts[2]===password;if(!allowed)return send('535 5.7.8 Authentication failed');const finish=()=>{if(!socket.destroyed){authenticated=true;send('235 2.7.0 Authentication successful');}};if(nextAuthenticationHold){const gate=nextAuthenticationHold;nextAuthenticationHold=null;gate.resume=finish;socket.once('close',gate.closed);gate.held();}else finish();};
  send('220 localhost SMTP test ready');
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>2*1024*1024)return socket.destroy();let index;while((index=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+2);
   if(inData){if(line==='.'){messages.push({to:[...to],data:dataLines.join('\r\n')});dataLines=[];to=[];inData=false;send('250 2.0.0 Accepted');}else{dataLines.push(line.startsWith('..')?line.slice(1):line);if(dataLines.reduce((n,s)=>n+s.length,0)>1024*1024)socket.destroy();}continue;}
   if(authPending){authPending=false;auth(line);continue;}
   const space=line.indexOf(' '),command=(space<0?line:line.slice(0,space)).toUpperCase(),arg=space<0?'':line.slice(space+1);
   if(command==='EHLO'){send('250-localhost');send('250-AUTH PLAIN');send('250 SIZE 1048576');}
   else if(command==='HELO')send('250 localhost');
   else if(command==='AUTH'&&arg.toUpperCase().startsWith('PLAIN')){const token=arg.slice(5).trim();if(token)auth(token);else{authPending=true;send('334 ');}}
   else if(command==='NOOP')send('250 OK');
   else if(command==='RSET'){to=[];dataLines=[];send('250 OK');}
   else if(command==='QUIT'){send('221 Bye');socket.end();}
   else if(command==='MAIL'){if(!authenticated)send('530 Authentication required');else{to=[];send('250 OK');}}
   else if(command==='RCPT'){if(!authenticated)send('530 Authentication required');else{const recipient=/^TO:\s*<([^>]+)>/i.exec(arg);if(!recipient)send('501 Bad recipient');else{to.push(recipient[1]);send('250 OK');}}}
   else if(command==='DATA'){if(!authenticated||!to.length)send('503 Bad sequence');else{inData=true;send('354 End with dot');}}
   else send('502 Command not implemented');
  }});
 });
 server.on('tlsClientError',()=>{});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {host:'127.0.0.1',port:server.address().port,caPath,user,password,from,messages,
  holdNextAuthentication(){if(nextAuthenticationHold)throw Error('SMTP_TEST_HOLD_ALREADY_PENDING');let held,closed;const gate={held:()=>held(),closed:()=>closed(),resume:null};const holding=new Promise(resolve=>{held=resolve;}),ended=new Promise(resolve=>{closed=resolve;});nextAuthenticationHold=gate;return {waitForHeld:()=>holding,waitForClosed:()=>ended,release:()=>gate.resume?.()};},
  async waitForMessage(predicate,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const message=messages.find(predicate);if(message)return message;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('SMTP_TEST_MESSAGE_TIMEOUT');},
  async stop(){if(closing)return;closing=true;for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});},
 };
}
module.exports={createTlsSmtpFixture};
