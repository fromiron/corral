import { expect, it } from 'vitest';
import { GitDiffRequest, UserGitTarget } from '../src/index.ts';

const project = {
  kind: 'project' as const,
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
};
const session = { ...project, kind: 'session' as const, sessionId: 'session', copyGeneration: 2 };
const request = {
  target: project,
  side: 'unstaged',
  path: ' 한글/line\nname.ts ',
  head: null,
  indexHash: 'a'.repeat(64),
};

it('[TC-WBD-008-H] keeps original and managed-copy identities distinct and does not normalize raw paths', () => {
  expect(UserGitTarget.parse(project)).toEqual(project);
  expect(UserGitTarget.parse(session)).toEqual(session);
  expect(GitDiffRequest.parse(request)).toEqual(request);
  for (const head of ['a'.repeat(40), 'b'.repeat(64)])
    expect(GitDiffRequest.parse({ ...request, target: session, head }).head).toBe(head);
});

it('[TC-WBD-008-N] rejects missing generations, malformed versions and mutation fields', () => {
  for (const target of [
    { ...project, copyGeneration: 1 },
    { ...session, copyGeneration: 0 },
    { ...project, kind: 'session' },
    { ...project, bindingId: undefined },
  ])
    expect(UserGitTarget.safeParse(target).success).toBe(false);
  for (const change of [
    { head: 'HEAD' },
    { indexHash: 'short' },
    { path: '' },
    { path: 'a'.repeat(4097) },
    { side: 'commit' },
    { operationId: 'operation' },
    { force: true },
  ])
    expect(GitDiffRequest.safeParse({ ...request, ...change }).success).toBe(false);
});
