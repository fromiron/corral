import type { RunStore } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { DemoWorkspace } from './workspace.ts';

const cancellation = { aborted: false, onCancel: () => () => {} };

function workspace() {
  const store = { getRun: () => ({ sessionId: 'session_1' }) } as unknown as RunStore;
  const demo = new DemoWorkspace(store);
  demo.bind('default', 'demo://example-repo');
  demo.configure('default', { trusted: true });
  demo.createWorktree('session_1', 'default');
  const call = (name: 'list_files' | 'read_file', args: Record<string, unknown>) =>
    demo.execute(
      { name, args, runId: 'run_1', executionId: 'exec_1', toolCallId: 'tool_1' },
      cancellation,
    );
  return { call };
}

describe('the demo file broker', () => {
  it('list_files with a folder that names the root lists the root; other paths keep their refusals', async () => {
    const { call } = workspace();
    const whole = await call('list_files', {});
    expect((whole.files as unknown[]).length).toBeGreaterThan(0);
    for (const path of ['.', './', '']) expect(await call('list_files', { path })).toEqual(whole);
    await expect(call('list_files', { path: '..' })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
    });
    await expect(call('list_files', { path: '/etc' })).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
    });
    for (const path of ['.git', '.corral'])
      await expect(call('list_files', { path })).rejects.toMatchObject({
        code: 'CAPABILITY_DENIED',
      });
    await expect(call('read_file', { path: '.' })).rejects.toMatchObject({
      code: 'SCHEMA_INVALID',
      message: 'the path names no file',
    });
  });
});
