import type { HarnessPreviewRole } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ReadHarnessAsk, useOutriderTargets } from '../src/team-editor/useOutriderTargets.ts';

const harness = { profileId: 'shared', revision: 2 };
const skill = { resourceHash: 'a'.repeat(64), entry: 'guide/SKILL.md' };
const reference = (id: string, corralId: string) => ({
  id,
  label: id,
  type: 'team' as const,
  source: { kind: 'reference' as const, corralId, definitionRevision: 1 },
});

describe('Outrider ask permissions', () => {
  it('shares previews by binding and selection, using the referenced team’s own role', async () => {
    const host = linearCorral(['worker', 'copy', 'inherit'], 'host');
    const other = { ...skill, entry: 'other/SKILL.md' };
    Object.assign(host.roles[0]!, { harness, skills: [skill, other] });
    Object.assign(host.roles[1]!, { harness, skills: [other, skill, skill] });
    host.roles[2]!.harness = harness;
    const middle = linearCorral(['plain'], 'middle');
    const nested = linearCorral(['worker'], 'nested');
    Object.assign(nested.roles[0]!, { harness, skills: [] });
    host.nodes.push(reference('outer', middle.id));
    middle.nodes.push(reference('inner', nested.id));
    const resolve = (id: string, rev: number) =>
      rev === 1 ? [middle, nested].find((team) => team.id === id) : undefined;
    const read = vi.fn(async ({ skills }: HarnessPreviewRole) => skills?.length !== 0);
    const hook = renderHook(() => useOutriderTargets(host, true, resolve, read));
    expect(
      hook.result.current.filter((row) => row.permissionPending).map((row) => row.nodeId),
    ).toEqual(['worker', 'copy', 'inherit', 'outer.inner.worker']);
    await waitFor(() =>
      expect(hook.result.current.some((row) => row.permissionPending)).toBe(false),
    );
    expect(read.mock.calls).toEqual([
      [{ id: 'worker_role', harness, skills: [skill, other] }],
      [{ id: 'inherit_role', harness }],
      [{ id: 'worker_role', harness, skills: [] }],
    ]);
    expect(hook.result.current.map((row) => [row.nodeId, row.unavailable])).toEqual([
      ['worker', undefined],
      ['copy', undefined],
      ['inherit', undefined],
      ['outer.plain', undefined],
      ['outer.inner.worker', 'harness'],
    ]);
  });

  it('checks different MCP selections independently, even under the same policy', async () => {
    const team = linearCorral(['inherited', 'none', 'selected', 'same']);
    const ref = { serverId: 'issues', name: 'mcp__issues__search' };
    for (const [index, role] of team.roles.entries()) {
      role.harness = harness;
      if (index > 0) role.mcpTools = index === 1 ? [] : [ref];
    }
    const read = vi.fn<ReadHarnessAsk>(async ({ mcpTools }) => !mcpTools?.length);
    const hook = renderHook(() => useOutriderTargets(team, true, undefined, read));
    await waitFor(() => expect(hook.result.current.some((r) => r.permissionPending)).toBe(false));
    expect(read).toHaveBeenCalledTimes(3);
    expect(hook.result.current.map((r) => r.unavailable)).toEqual([
      undefined,
      undefined,
      'harness',
      'harness',
    ]);
  });

  it('leaves unreadable skills-only previews pending and ignores a late answer from a previous project', async () => {
    const team = linearCorral(['empty', 'selected', 'broken', 'plain']);
    team.roles[0]!.skills = [];
    team.roles[1]!.skills = [skill];
    team.roles[2]!.skills = [{ ...skill, entry: 'other/SKILL.md' }];
    let resolveOld!: (allowed: boolean) => void;
    const old = new Promise<boolean>((resolve) => {
      resolveOld = resolve;
    });
    const first = vi.fn<ReadHarnessAsk>(() => old);
    const next = vi.fn<ReadHarnessAsk>(async ({ id }) => {
      if (id === 'broken_role') throw new Error('unavailable');
      return id === 'empty_role' ? false : undefined;
    });
    const hook = renderHook((read) => useOutriderTargets(team, true, undefined, read), {
      initialProps: first,
    });
    expect(first).toHaveBeenCalledTimes(3);
    hook.rerender(next);
    await act(async () => resolveOld(true));
    expect(next).toHaveBeenCalledTimes(3);
    expect(hook.result.current.map((row) => [row.unavailable, row.permissionPending])).toEqual([
      ['harness', undefined],
      [undefined, true],
      [undefined, true],
      [undefined, undefined],
    ]);
  });
});
