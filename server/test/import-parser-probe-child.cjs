process.once('message',()=>{

  if(process.argv[2]==='exit') process.exit(7);
  else if(process.argv[2]==='malformed') process.send({result:{format:'docx',segments:[{ordinal:0,page:null,text:42}],warnings:[]}});
  else setInterval(()=>{},1000);
});