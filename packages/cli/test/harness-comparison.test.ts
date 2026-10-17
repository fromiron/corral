import { expect, it } from 'vitest';
import { runHarnessComparison } from './fixtures/personal-harness.ts';

it('[TC-HAR-014-H] runs five conditions through the actual SDK with fresh copies and separate holdout evidence',async()=>{
  const result=await runHarnessComparison();
  expect(result.kind).toBe('local_sdk_fixture');
  expect(result.report.results).toHaveLength(10);
  expect(result.report.summary).toHaveLength(10);
  expect(new Set(result.report.results.map(row=>row.workspace?.sessionId)).size).toBe(10);
  for(const row of result.report.results){
    expect(row.status,`${row.group}/${row.brief}: ${row.reason}`).toBe('succeeded');
    expect(row.quality?.finalCorrect).toBe(true);
    expect(row.metricsComplete).toBe(true);
    expect(row.harnessHashes.length).toBeGreaterThan(0);
    expect(row.workspace?.baseCommit).toBe(result.baseCommit);
    if(row.group==='review_repair')expect(row.repairRounds).toBe(1);
    if(row.group==='coding_tool')expect(row.toolsExecuted).toContain('edit');
    if(row.group==='deterministic_check')expect(row.toolsExecuted).toContain('run_check');
  }
  expect(result.evidence.mandatorySkillObserved).toBe(2);
  expect(result.evidence.completedChecks).toBe(6);
},60_000);
