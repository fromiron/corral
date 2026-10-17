import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodemodeExtension, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

it('[TC-HAR-017-H] the official codemode factory reports the actual worker exit with its call ID', async()=>{
  const directory=mkdtempSync(join(tmpdir(),'corral-codemode-'));
  try {
  const exits:{id:string;exited:Promise<void>}[]=[];
  const loader=new DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[{name:'codemode',factory:createCodemodeExtension({models:false,onWorkerStarted:(id,exited)=>{exits.push({id,exited});}})}]});
  await loader.reload();
  const {runtime,extensions}=loader.getExtensions();
  runtime.getAllTools=()=>[];
  runtime.getSettings=()=>({});
  const extension=extensions[0]!;
  const tool=extension.tools.get('codemode')!.definition;
  const result=await tool.execute('call_one',{code:'text(42)'},undefined,undefined,undefined as never);
  expect(JSON.stringify(result)).toContain('42');
  expect(exits.map(row=>row.id)).toEqual(['call_one']);
  await Promise.all(exits.map(row=>row.exited));
  } finally {rmSync(directory,{recursive:true,force:true});}
},10000);
