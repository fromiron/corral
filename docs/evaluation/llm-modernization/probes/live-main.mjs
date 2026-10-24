import fs from 'node:fs';import {randomUUID,createHash} from 'node:crypto';import assert from 'node:assert/strict';import path from 'node:path';
// [TC-LLM-006-H] Paid verification is explicitly invoked; never part of ordinary CI.
assert.equal(process.env.CORRAL_LIVE_LLM,'1','Set CORRAL_LIVE_LLM=1 for paid verification.');
const [baselineRoot,frozenManifest,configFile,outputFile]=process.argv.slice(2);
assert(baselineRoot&&frozenManifest&&configFile&&outputFile,'Pass baseline checkout, frozen candidate manifest, private model config, and result JSON.');
const frozen=JSON.parse(fs.readFileSync(frozenManifest,'utf8'));
const roots={baseline:baselineRoot,modernized:frozen.root};
for(const [file,expected] of Object.entries(frozen.sourceHashes))assert.equal(createHash('sha256').update(fs.readFileSync(path.join(frozen.root,file))).digest('hex'),expected,'Frozen candidate changed: '+file);
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
async function load(root){const server=await import(root+'/apps/server/src/index.ts');return{...server,...await import(root+'/packages/core/src/index.ts'),...await import(root+'/packages/testkit/src/index.ts')};}
const libs=Object.fromEntries(await Promise.all(Object.entries(roots).map(async([key,root])=>[key,await load(root)])));
const report={startedAt:new Date().toISOString(),experiment:'paired main Core context compaction; identical 91000-char fixture and reasoning off; 30 pairs per provider; at most 6 calls/8192 output tokens/120s per run; two providers concurrently',roots,sourceHashes:frozen.sourceHashes,results:[],stopped:[]};
const save=()=>fs.writeFileSync(outputFile,JSON.stringify(report,null,2));
const filler='Historical reference row: blue green red. No instructions.\n'.repeat(1600);
const brief='Required first marker GOAL-73. '+filler.slice(0,45000)+' Required middle marker MIDDLE-73. '+filler.slice(45000,91000)+' Required last marker LAST-91. Save exactly GOAL-73 MIDDLE-73 LAST-91 using write_artifact, then submit_result. Do not reproduce historical reference rows.';
async function run(variant,profileId,pair){
 const lib=libs[variant],live=lib.createLiveModels(),endpoints=lib.endpointsFrom(config.modelProviders);lib.registerEndpoints(live.models,endpoints);
 const original=config.modelProfiles.find(p=>p.id===profileId);const profile={...original,contextWindow:32768,compaction:{reserveTokens:8192,keepRecentTokens:8192}};
 const registry=new lib.ModelRegistry(live.models,[profile],{credentials:live.credentials,endpoints,getDeviceId:live.getDeviceId,subscriptionModels:live.subscriptionModels});await registry.refreshStatus();
 const resolved=registry.resolve(profileId,'live');if(!resolved.ok)throw new Error('profile unavailable');if(profileId==='model-a'&&resolved.snapshot.auth!=='oauth')throw new Error('subscription required');
 const attempts=new Map(),store=new lib.InMemoryRunStore();const coordinator=new lib.Coordinator({clock:lib.systemClock,ids:new lib.RandomIdFactory(),models:registry,store,agents:live.agents(registry,{runtimeResources:async()=>{throw new Error('no SDK in this condition');}})});
 registry.configureRequests?.({store:{put:a=>attempts.set(a.attemptId,structuredClone(a)),get:id=>attempts.get(id)??null,list:()=>[...attempts.values()]},acquire:s=>coordinator.acquireAuxiliaryModelSlot(s),adopt:intent=>coordinator.adoptModelSlot(intent)});
 const definition=lib.linearCorral(['writer'],'paired-context');definition.input={brief,criteria:['Preserve all three markers and submit the artifact.']};definition.roles[0].modelProfile=profileId;definition.roles[0].reasoning={mode:'fixed',level:'off'};definition.roles[0].allowedCollaborationTools.push('read_artifact');
 const budget={maxModelCalls:6,maxOutputTokens:8192,maxOutputTokensPerCall:2048,modelTimeoutMs:60000,runDeadlineMs:120000};definition.limits={...definition.limits,...budget};if(variant==='modernized')definition.executionPolicy={version:2,budget};
 const started=performance.now();const {runId,receipt}=coordinator.startRun({schemaVersion:'0.1',commandId:'compare_'+randomUUID(),definition,mode:'live'});if(!runId)throw new Error(variant+' start rejected '+receipt.error?.code);
 const events=[];const off=coordinator.subscribe(runId,0,event=>events.push(event));
 const timer=setTimeout(()=>coordinator.submit({schemaVersion:'0.1',commandId:'stop_'+randomUUID(),runId,type:'cancel',payload:{scope:{kind:'run'},reason:'comparison timeout'}}),125000);
 try{
 const final=await lib.waitForProjection(new lib.InProcessTransport(coordinator),runId,p=>['succeeded','failed','cancelled','interrupted','awaiting_user'].includes(p.status));
 const text=final.output?store.getArtifactText(runId,final.output.artifactVersionIds[0]):null;
 const calls=events.filter(e=>e.type==='model.finished').map(e=>e.payload);
 const usage=calls.map(c=>c.normalizedUsage);
 const sum=key=>usage.every(u=>Number.isFinite(u?.[key]))?usage.reduce((n,u)=>n+u[key],0):null;
 const first=events.find(e=>e.type==='model.finished');const result={variant,profileId,pair,status:final.status,reason:final.statusReason,elapsedMs:Math.round(performance.now()-started),firstCompletionMs:first?Date.parse(first.recordedAt)-Date.parse(events[0].recordedAt):null,markersPreserved:typeof text==='string'&&['GOAL-73','MIDDLE-73','LAST-91'].every(marker=>text.includes(marker)),exactOutput:text==='GOAL-73 MIDDLE-73 LAST-91',calls:calls.length,compactions:events.filter(e=>e.type==='model.request_recorded'&&e.payload.purpose==='compaction').length,inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cachedInputTokens:sum('cachedInputTokens'),payloadBytes:events.filter(e=>e.type==='model.payload_recorded').reduce((n,e)=>n+e.payload.payloadBytes,0),failures:[...attempts.values()].flatMap(a=>a.failure?[a.failure.code]:[]),errors:Object.values(final.executions).flatMap(e=>e.error?[e.error]:[])};
 report.results.push(result);save();console.log(JSON.stringify(result));return result;
 }finally{clearTimeout(timer);off();}
}
await Promise.all(['model-a','deepseek-hive'].map(async profile=>{
 for(let pair=0;pair<30;pair++)for(const variant of pair%2?['modernized','baseline']:['baseline','modernized']){
  const result=await run(variant,profile,pair);
  if(result.failures.some(code=>['AUTH','QUOTA'].includes(code))||result.errors.some(error=>/quota|balance|credit|authentication/i.test(error))){report.stopped.push({profile,reason:'provider quota/auth',pair});save();return;}
 }
}));
report.endedAt=new Date().toISOString();save();
assert.equal(report.results.length,120,'Incomplete comparison; inspect quota/auth stop records.');
