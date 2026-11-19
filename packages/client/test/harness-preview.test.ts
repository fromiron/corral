import { expect, it } from 'vitest';
import { HarnessApi } from '../src/index.ts';

it('sends role selections including an explicit empty list without leaking the rest of the role', async () => {
  const requests: unknown[] = [];
  const api = new HarnessApi({
    baseUrl: '',
    fetch: async (url, init) => {
      if (String(url).endsWith('/session')) return Response.json({ csrfToken: 'test' });
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ snapshot: null, problem: null });
    },
  });
  const binding = { profileId: 'writer', revision: 2 };
  const skills = [{ resourceHash: 'a'.repeat(64), entry: 'skills/style/SKILL.md' }];
  const role = { id: 'writer_role', skills, harness: binding, prompt: 'private' };
  await api.preview(role, 'project');
  await api.preview({ id: 'reader_role', skills: [] }, 'project');
  await api.preview(binding, 'project', binding);
  expect(requests).toEqual([
    { projectId: 'project', roleId: 'writer_role', binding, skills },
    { projectId: 'project', roleId: 'reader_role', skills: [] },
    { projectId: 'project', binding, runOverride: binding },
  ]);
});
