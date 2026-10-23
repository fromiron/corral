import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/files/service.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(io?: ConstructorParameters<typeof WorkspaceService>[0]['io']) {
  const root = mkdtempSync(join(tmpdir(), 'corral-file-edits-')),
    original = join(root, 'original');
  execFileSync('git', ['init', '-q', original]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', ...args], {
      cwd: original,
    });
  writeFileSync(join(original, 'a.ts'), '\ufeffconst Old = "😀";\r\n');
  writeFileSync(join(original, 'b.ts'), 'export const value = Old;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions(id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,entries_json) VALUES('s1','default',NULL,'t','',0,1,'x','x','[]')",
  ).run();
  const clock = new FakeClock();
  const make = () =>
    new WorkspaceService({
      db,
      clock,
      worktreeRoot: join(root, 'copies'),
      forbidden: [],
      hostId: 'host',
      allowSharedDevelopment: true,
      io,
    });
  let service = make();
  cleanups.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const copy = await service.createWorktree('s1', 'default');
  const target = {
    hostId: 'host',
    projectId: 'default',
    bindingId: copy.bindingId,
    sessionId: 's1',
    copyGeneration: copy.copyGeneration,
  };
  const path = service.copyOf('s1')!.worktree;
  return {
    get service() {
      return service;
    },
    restart: async () => {
      await service.dispose();
      service = make();
    },
    db,
    clock,
    target,
    path,
    original,
    preview: {
      kind: 'replace' as const,
      target,
      requestId: 'preview_1',
      query: 'Old',
      caseSensitive: true,
      replacement: '$&New',
    },
  };
}

it('[TC-WBD-021-H] previews immutable bytes, applies a shared batch once and explicitly previews its inverse', async () => {
  const s = await setup();
  const before = readFileSync(join(s.path, 'a.ts'), 'utf8');
  const now = s.clock.nowIso.bind(s.clock);
  vi.spyOn(s.clock, 'nowIso').mockImplementation(() => {
    s.clock.advance(1);
    return now();
  });
  const [first, repeated] = await Promise.all([
    s.service.previewFileEdits('s1', s.preview),
    s.service.previewFileEdits('s1', s.preview),
  ]);
  expect(repeated).toEqual(first);
  const {
    proposals: [proposal],
  } = first;
  if (!proposal) throw new Error('proposal missing');
  expect(readFileSync(join(s.path, 'a.ts'), 'utf8')).toBe(before);
  expect(proposal.files).toHaveLength(2);
  expect(proposal.files[0]?.after).toContain('$&New');
  expect((await s.service.previewFileEdits('s1', s.preview)).proposals[0]).toEqual(proposal);
  await s.service.startDevelopment('s1', { target: s.target, operationId: 'development' });
  const input = { target: s.target, operationId: 'apply_1', proposalHash: proposal.hash };
  const applied = await s.service.applyFileEdits('s1', proposal.proposalId, input);
  expect(applied.state).toBe('succeeded');
  expect(applied.result.outcomes.map((file) => file.state)).toEqual(['applied', 'applied']);
  expect(await s.service.applyFileEdits('s1', proposal.proposalId, input)).toEqual(applied);
  expect(readFileSync(join(s.path, 'a.ts'), 'utf8')).toBe('\ufeffconst $&New = "😀";\r\n');
  const inverse = await s.service.inverseFileEdits('s1', proposal.proposalId, {
    ...input,
    requestId: 'inverse_1',
  });
  expect(
    await s.service.applyFileEdits('s1', inverse.proposalId, {
      target: s.target,
      operationId: 'undo_1',
      proposalHash: inverse.hash,
    }),
  ).toMatchObject({ state: 'succeeded' });
  expect(readFileSync(join(s.path, 'a.ts'), 'utf8')).toBe(before);
  expect(readFileSync(join(s.original, 'a.ts'), 'utf8')).toBe(before);
  expect(await s.service.finishDevelopment('s1', 'development', s.target)).toMatchObject({
    operation: null,
  });
});

it('[TC-WBD-021-N] preflights every file and rejects stale targets or incomplete replacement searches without touching other files', async () => {
  const s = await setup();
  const proposal = (await s.service.previewFileEdits('s1', s.preview)).proposals[0]!;
  writeFileSync(join(s.path, 'b.ts'), 'external Old\n');
  const failed = await s.service.applyFileEdits('s1', proposal.proposalId, {
    target: s.target,
    operationId: 'stale',
    proposalHash: proposal.hash,
  });
  expect(failed.state).toBe('failed');
  expect(failed.result.outcomes.every((file) => file.state === 'unchanged')).toBe(true);
  expect(readFileSync(join(s.path, 'a.ts'), 'utf8')).toContain('const Old');
  await expect(
    s.service.applyFileEdits('s1', proposal.proposalId, {
      target: { ...s.target, copyGeneration: 2 },
      operationId: 'foreign',
      proposalHash: proposal.hash,
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  writeFileSync(join(s.path, 'many.ts'), 'Old\n'.repeat(201));
  await expect(
    s.service.previewFileEdits('s1', { ...s.preview, requestId: 'limited' }),
  ).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
});

it('[TC-WBD-021-F] retains partial and uncertain outcomes, never replays after restart, and never rolls back external edits', async () => {
  let writes = 0;
  const s = await setup({
    rename: async (from, to) => {
      writes++;
      if (writes === 2) {
        await rename(from, to);
        throw new Error('lost IO acknowledgement');
      }
      return rename(from, to);
    },
  });
  const proposal = (await s.service.previewFileEdits('s1', s.preview)).proposals[0]!;
  const input = { target: s.target, operationId: 'partial', proposalHash: proposal.hash };
  expect(await s.service.applyFileEdits('s1', proposal.proposalId, input)).toMatchObject({
    state: 'uncertain',
    result: { outcomes: [{ state: 'applied' }, { state: 'uncertain' }] },
  });
  await s.restart();
  expect(await s.service.applyFileEdits('s1', proposal.proposalId, input)).toMatchObject({
    state: 'uncertain',
  });
  expect(writes).toBe(2);
  expect(
    await s.service.reconcileFileEdits('s1', { target: s.target, operationId: 'partial' }),
  ).toMatchObject({ state: 'succeeded' });
  writeFileSync(join(s.path, 'a.ts'), 'external result\n');
  await expect(
    s.service.inverseFileEdits('s1', proposal.proposalId, { ...input, requestId: 'inverse' }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(readFileSync(join(s.path, 'a.ts'), 'utf8')).toBe('external result\n');
  expect(readFileSync(join(s.path, 'b.ts'), 'utf8')).toContain('$&New');
  const next = (
    await s.service.previewFileEdits('s1', {
      ...s.preview,
      requestId: 'receipt_preview',
      query: '$&New',
      replacement: 'Final',
    })
  ).proposals[0]!;
  s.db.exec(
    `CREATE TRIGGER fail_batch_receipt BEFORE UPDATE OF state ON workbench_operations WHEN NEW.operation_id='receipt_lost' AND NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'receipt lost'); END;`,
  );
  expect(
    await s.service.applyFileEdits('s1', next.proposalId, {
      target: s.target,
      operationId: 'receipt_lost',
      proposalHash: next.hash,
    }),
  ).toMatchObject({ state: 'uncertain' });
  expect(readFileSync(join(s.path, 'b.ts'), 'utf8')).toContain('Final');
  s.db.exec('DROP TRIGGER fail_batch_receipt');
  expect(
    await s.service.reconcileFileEdits('s1', { target: s.target, operationId: 'receipt_lost' }),
  ).toMatchObject({ state: 'succeeded' });
});
