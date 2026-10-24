import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
const [piRoot,dshRoot,output]=process.argv.slice(2);
assert(piRoot&&dshRoot,'Pass the pinned PI-Desktop and DSH checkout paths.');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:piRoot,encoding:'utf8'}).trim(),'1a812ed7b84e0bd1b117080eb4e51c76eba35d48');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:dshRoot,encoding:'utf8'}).trim(),'22ddee3792402c3e70ec5f86a63c3e3e895a2f60');
const hashes={};
function extract(file,names){
 const text=fs.readFileSync(file,'utf8');hashes[path.relative(path.dirname(file),file)]=createHash('sha256').update(text).digest('hex');
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 return ast.statements.filter(node=>ts.isFunctionDeclaration(node)?names.includes(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>names.includes(d.name.getText()))).map(n=>n.getText(ast)).join('\n');
}
async function moduleOf(text){return import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));}
const original=await moduleOf(extract(piRoot+'/packages/agent-runtime/src/context-budget.ts',['COMPACTION_RESERVE_FLOOR_TOKENS','COMPACTION_KEEP_RECENT_RATIO','COMPACTION_MIN_KEEP_RECENT_TOKENS','COMPACTION_MAX_KEEP_RECENT_TOKENS','AUTO_COMPACTION_TRIGGER_RATIO','contextBudgetLimitsFor','automaticCompactionThresholdFor'])+'\n'+extract(piRoot+'/packages/agent-runtime/src/provider-binding.ts',['DEFAULT_CONTEXT_WINDOW','DEFAULT_MAX_TOKENS']));
const local=await import(path.resolve('packages/pi-runtime-port/src/context-budget.ts'));
const fixtures=[{contextWindow:256000,maxTokens:32000},{contextWindow:32000,maxTokens:8000},{contextWindow:64000,maxTokens:16000},{contextWindow:1048576,maxTokens:64000},...[100,4000,8000,16000,32000,64000,128000,200000,256000,1048576,2000000].map(contextWindow=>({contextWindow,maxTokens:8192}))];
for(const fixture of fixtures){assert.deepEqual(local.contextBudgetLimitsFor(fixture),original.contextBudgetLimitsFor(fixture));assert.equal(local.automaticCompactionThresholdFor(local.contextBudgetLimitsFor(fixture)),original.automaticCompactionThresholdFor(original.contextBudgetLimitsFor(fixture)));}
const dsh=await moduleOf(extract(dshRoot+'/packages/llm/llm-retry/src/index.ts',['localDelay'])+'\nexport {localDelay};');
const {retryDelay}=await import(path.resolve('packages/adapter-pi/src/ported/dsh/retry.ts'));
for(const retry of [0,1])for(const random of [0,.5,1])assert.equal(retryDelay({code:'SERVER',status:503,retryAfterMs:null,requestId:null},retry,()=>random),dsh.localDelay({initialDelayMs:500,maxDelayMs:10000,jitterRatio:.1},retry+1,()=>random));
assert.equal(local.contextBudgetLimitsFor({contextWindow:1,maxTokens:1}).keepRecentTokens,0);
const result={checkedAt:new Date().toISOString(),piFixtureCases:fixtures.length,piAssertions:fixtures.length*2,dshDelayCases:6,sourceHashes:hashes,intentionalDifferences:['Corral unknown metadata fallback is 32000/4096 rather than PI 128000/8192.','One-token windows retain zero tokens rather than claiming one retained token fits.','Corral permits two retries; DSH retry numbering is one-based and its default maximum is five. Retry-After is preserved even above the local backoff cap.']};
if(output)fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
