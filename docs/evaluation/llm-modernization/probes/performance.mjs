import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.cwd();
const {createStreamCoalescer,createStreamDecoder}=await import(root+'/packages/pi-runtime-port/src/stream.ts');
const {fauxAssistantMessage}=await import(root+'/packages/adapter-pi/node_modules/@earendil-works/pi-ai/dist/index.js');
const {encodeContextCheckpoint,decodeContextCheckpoint}=await import(root+'/packages/core/src/context-checkpoint.ts');
const {linearCorral}=await import(root+'/packages/testkit/src/index.ts');
const {canonicalJson}=await import(root+'/packages/contracts/src/index.ts');
const digest=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const ipc=[];
for(const size of [65536,131072])for(const blocks of [1,64]){
 let bytes=0,frames=0,text='';const decode=createStreamDecoder();
 const coalescer=createStreamCoalescer(event=>{const frame=JSON.stringify({bridge:'model',id:'stream_1',type:'event',event});bytes+=Buffer.byteLength(frame);frames++;const e=decode(JSON.parse(frame).event);if(e.type==='text_delta')text+=e.delta;},()=>()=>{});
 const partial={...fauxAssistantMessage(''),content:[]};coalescer.push({type:'start',partial});
 for(let block=0;block<blocks;block++){
  partial.content.push({type:'text',text:''});coalescer.push({type:'text_start',contentIndex:block,partial});
  for(let offset=0;offset<size/blocks;offset+=64){partial.content[block].text+='x'.repeat(64);coalescer.push({type:'text_delta',contentIndex:block,delta:'x'.repeat(64),partial});}
  coalescer.push({type:'text_end',contentIndex:block,content:partial.content[block].text,partial});
 }
 coalescer.push({type:'done',reason:'stop',message:partial});coalescer.dispose();assert.equal(text,'x'.repeat(size));if(size===65536)assert(bytes<1048576);ipc.push({outputBytes:size,blocks,frames,ipcBytes:bytes});
}
const chunks=new Map(), context={messages:[{role:'user',content:'Original source '.repeat(5000),timestamp:0}]};let oldBytes=0,newBytes=0,oldMs=0,newMs=0;let last;
for(let n=0;n<100;n++){
 context.messages.push({role:'user',content:`message ${n}: `+'한日🙂 code '.repeat(300),timestamp:n+1});
 const state={version:1,context:{version:1,piVersion:'1.3.0',runtime:'pi-core',context,contextHash:digest(context)},role:linearCorral(['writer']).roles[0],criteria:'Preserve source references',protectedContext:{version:1,text:'current',hash:digest('current')}};
 let t=performance.now();const full=canonicalJson(state);oldBytes+=Buffer.byteLength(full);oldMs+=performance.now()-t;
 t=performance.now();last=encodeContextCheckpoint(state);newBytes+=Buffer.byteLength(last.text);for(const [id,body] of last.chunks)if(!chunks.has(id)){chunks.set(id,body);newBytes+=Buffer.byteLength(body);}newMs+=performance.now()-t;
}
assert.deepEqual(decodeContextCheckpoint(last.stored,id=>chunks.get(id)??null).context.context,context);
const report={checkedAt:new Date().toISOString(),node:process.version,ipc,checkpoint:{snapshots:100,oldBytes,newBytes,uniqueChunks:chunks.size,oldSerializationMs:Math.round(oldMs),newEncodingMs:Math.round(newMs),note:'Canonical storage-body bytes and CPU encoding only; no SQLite filesystem compression or I/O latency claim.'}};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2));console.log(JSON.stringify(report));
