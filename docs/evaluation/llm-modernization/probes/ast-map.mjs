import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const root=process.cwd();
const out=process.argv[2];
assert(out, 'Usage: node docs/evaluation/llm-modernization/probes/ast-map.mjs OUTPUT_DIRECTORY');
fs.mkdirSync(out,{recursive:true});
const files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','dist','staging','release','.git','test','tests','e2e'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(ts|tsx|mts)$/.test(p)&& !/\.(test|spec|stories)\./.test(p))files.push(p);}}
walk(root+'/apps');walk(root+'/packages');
const program=ts.createProgram(files,{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,jsx:ts.JsxEmit.ReactJSX,allowImportingTsExtensions:true,skipLibCheck:true,noEmit:true});
const checker=program.getTypeChecker();
const calls=[],imports=[],constants=[],routes=[],functions=[];
const location=n=>({file:path.relative(root,n.getSourceFile().fileName),line:n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1});
const fnName=n=>n.name?.getText() || (ts.isVariableDeclaration(n.parent)?n.parent.name.getText():ts.isPropertyAssignment(n.parent)?n.parent.name.getText():'<callback>');
for(const file of files){const sf=program.getSourceFile(file);if(!sf)continue;
 function visit(n,owner='<module>'){
  if(ts.isFunctionLike(n)&&n.body){owner=fnName(n);functions.push({...location(n),name:owner});}
  if(ts.isImportDeclaration(n))imports.push({...location(n),module:n.moduleSpecifier.text,names:n.importClause?.getText()??''});
  if(ts.isCallExpression(n)||ts.isNewExpression(n)){
   let declaration;try{declaration=checker.getResolvedSignature(n)?.declaration;}catch{}
   const call={...location(n),owner,callee:n.expression.getText().replace(/\s/g,''),...(declaration?{target:{...location(declaration),name:fnName(declaration)}}:{})};calls.push(call);
   if(/\.(get|post|put|patch|delete|route)$/.test(call.callee)&&n.arguments?.[0])routes.push({...call,route:n.arguments[0].getText().slice(0,400)});
  }
  if(ts.isVariableDeclaration(n)&&n.initializer&&/timeout|retry|limit|budget|tokens|concurr|cache|compact|bytes|steps|turns|deadline|backoff/i.test(n.name.getText()))constants.push({...location(n),name:n.name.getText(),value:n.initializer.getText().slice(0,1000)});
  ts.forEachChild(n,c=>visit(c,owner));
 }
 visit(sf);
}
assert(calls.some(c=>c.file==='apps/server/src/models/request-runtime.ts'&&c.callee==='models.streamSimple'));
const data={sourceCommit:'CR-052 working candidate; capture candidateHash alongside this graph', generatedAt:new Date().toISOString(),files:files.map(f=>path.relative(root,f)),functions,imports,calls,constants,routes};
fs.writeFileSync(out+'/ast-map.json',JSON.stringify(data,null,2));
const sinks=calls.filter(c=>/streamSimple|streamFn|createAgentSession|new Agent|\.prompt$|routeAuto|draftTeam|createAutoStarter|startRun|startRound|startMeeting/.test(c.callee)&&!c.file.includes('design-kit/'));
fs.writeFileSync(out+'/llm-calls.json',JSON.stringify(sinks,null,2));
// Every Pi send site has an owner, including the explicit standalone embedding boundary.
const transportFiles = {
 'apps/server/src/testing.ts':'mock/loopback fixture injection',
 'apps/server/src/models/request-runtime.ts':'host physical attempt + durable ledger',
 'apps/server/src/models/registry.ts':'managed runtime; unconfigured-embedder fallback; production broker.withPermit',
 'packages/adapter-pi/src/model-bridge.ts':'permit-bound host runtime or worker IPC',
 'packages/adapter-pi/src/worker-main.ts':'production bridge; raw fallback for standalone embedding',
 'packages/adapter-pi/src/sdk-worker-main.ts':'production bridge; raw fallback for standalone embedding',
 'packages/adapter-pi/src/worker.ts':'Core normal/summary -> Coordinator permit -> host bridge',
 'packages/adapter-pi/src/sdk-worker.ts':'SDK session/extension/summary -> scoped models proxy -> permit -> host bridge',
};
const transports=calls.filter(c=>/(?:^|\.)(?:streamSimple|streamFn|createAgentSession|completeSimple)$/.test(c.callee));
for(const call of transports){assert(transportFiles[call.file],`Unclassified Pi transport: ${call.file}:${call.line} ${call.callee}`);call.boundary=transportFiles[call.file];}
for(const [file,callee,boundary] of [
 ['apps/server/src/images-generation/service.ts','this.fetcher','image operation/effect -> shared ledger; no ambiguous resend'],
 ['apps/server/src/voice/service.ts','this.http','Realtime SDP/hangup control; sideband observes same call ID'],
 ['apps/server/src/voice/sideband.ts','WebSocket','Realtime usage observation -> shared ledger'],
]){const matches=calls.filter(c=>c.file===file&&c.callee===callee);assert(matches.length,`Missing modality boundary: ${file} ${callee}`);transports.push(...matches.map(c=>({...c,boundary})));}
fs.writeFileSync(out+'/transport-coverage.json',JSON.stringify(transports,null,2));
console.log(JSON.stringify({files:files.length,functions:functions.length,calls:calls.length,resolved:calls.filter(c=>c.target).length,routes:routes.length,sinks:sinks.length,artifact:out+'/ast-map.json'}));
