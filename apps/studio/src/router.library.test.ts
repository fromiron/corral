// @vitest-environment jsdom
import { createMemoryHistory } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { createStudioRouter } from './router.tsx';

// The library's addresses (docs/specs/features/library.md): `/library` opens Teams, and the old
// project Teams link lands there with its project. Both replace, so Back is the previous screen.

async function open(entries: string[]) {
  const router = createStudioRouter({} as never);
  const history = createMemoryHistory({
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  router.update({ ...router.options, history });
  await router.load();
  return { router, history };
}

it('opens the Teams view for /library, keeping its search', async () => {
  const { router, history } = await open(['/inbox', '/library?project=project_a']);
  expect(router.state.location.pathname).toBe('/library/teams');
  expect(router.state.location.search).toEqual({ project: 'project_a' });
  expect(history.length).toBe(2);
});

it("replaces an old project Teams link with the library's Teams view for that project", async () => {
  const { router, history } = await open(['/inbox', '/projects/project_a#corrals']);
  expect(router.state.location.pathname).toBe('/library/teams');
  expect(router.state.location.search).toEqual({ project: 'project_a' });
  expect(history.length).toBe(2);
  history.back();
  await router.load();
  expect(router.state.location.pathname).toBe('/inbox');
});

it('opens "draft a team from a goal" in the library templates for that project', async () => {
  const { router } = await open(['/projects/project_a?draft=1']);
  expect(router.state.location.pathname).toBe('/library/templates');
  expect(router.state.location.search).toEqual({ project: 'project_a', draft: true });
});
