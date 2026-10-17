import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('dependency recording includes spike/live manifests, multiple pinned versions and optional dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-deps-record-'));
  try {
    for (const path of ['apps/service', 'packages', 'spikes/legacy', 'tests/live', 'tools/deps', 'docs', 'bin']) mkdirSync(join(root,path),{recursive:true});
    const manifest=(path:string,data:unknown)=>writeFileSync(join(root,path,'package.json'),JSON.stringify(data));
    manifest('',{name:'root',packageManager:'pnpm@10.30.3',dependencies:{'fixture-lib':'2.0.0'}});
    manifest('apps/service',{name:'service',dependencies:{'fixture-lib':'2.0.0'}});
    manifest('spikes/legacy',{name:'legacy',dependencies:{'fixture-lib':'1.0.0'}});
    manifest('tests/live',{name:'live',optionalDependencies:{'fixture-client':'3.0.0'}});
    copyFileSync(join(import.meta.dirname,'../deps/record.ts'),join(root,'tools/deps/record.ts'));
    // A local registry fixture; this test never calls npm or the network.
    writeFileSync(join(root,'bin/pnpm'),`#!${process.execPath}\nconst spec=process.argv[3];const at=spec.lastIndexOf('@');console.log(JSON.stringify({license:'MIT',dist:{integrity:'fixture'},time:{[spec.slice(at+1)]:'2026-10-18T00:00:00.000Z'},repository:{url:'https://example.invalid/fixture'}}));`,{mode:0o700});
    execFileSync(process.execPath,[join(root,'tools/deps/record.ts')],{env:{PATH:`${join(root,'bin')}:${dirname(process.execPath)}`}});
    const output=JSON.parse(readFileSync(join(root,'docs/dependency-lock.json'),'utf8')) as {dependencies:{name:string;version:string;scope:string;usedBy:string[]}[]};
    assert.deepEqual(output.dependencies.map(record=>[record.name,record.version]),[['fixture-client','3.0.0'],['fixture-lib','1.0.0'],['fixture-lib','2.0.0']]);
    assert.deepEqual(output.dependencies.find(record=>record.version==='2.0.0')?.usedBy,['root','service']);
    assert.equal(output.dependencies.find(record=>record.name==='fixture-client')?.scope,'runtime');
  } finally {rmSync(root,{recursive:true,force:true});}
});
