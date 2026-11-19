// @vitest-environment jsdom

import type { CorralDefinition, OutputNode, SharedOutrider } from '@corral/contracts';
import { draftFromDefinition, setRequiredOutputReview } from '@corral/react';
import { linearCorral } from '@corral/testkit';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { assert, expect, it } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunSetupSummary } from './RunSetupSummary.tsx';

function summary(definition: CorralDefinition, savedRevision: number | null) {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunSetupSummary definition={definition} savedRevision={savedRevision} />
    </IntlProvider>,
  );
  expect(root.querySelector('h3')?.textContent).toBe('Will apply');
  return root;
}

function lines(definition: CorralDefinition) {
  return Array.from(summary(definition, 1).querySelectorAll('li'), (line) => line.textContent);
}

const shared: SharedOutrider = {
  modelProfile: 'critic',
  principles: 'Check the sources.',
  targets: { kind: 'all' },
};

function team() {
  const definition = linearCorral(['writer', 'editor']);
  const output = definition.nodes.find((node): node is OutputNode => node.type === 'output');
  assert(output);
  output.inputBindings = [{ kind: 'task_output', name: 'Report', sourceNodeId: 'writer' }];
  for (const node of definition.nodes) {
    if (node.id === 'writer') node.label = 'Researcher';
    if (node.id === 'editor') node.label = 'Editor';
  }
  return { definition, output };
}

it('shows only the final result and its bound submitter for a team without advice or reviews', () => {
  expect(lines(team().definition)).toEqual(['The final result “Report” comes from Researcher.']);
});

it('describes every result and gate, with the selected advice scope and the observation interval', () => {
  const { definition, output } = team();
  definition.sharedOutrider = {
    ...shared,
    targets: { kind: 'selected', nodeIds: ['writer', 'editor'] },
    artifactReview: true,
    observation: { targets: { kind: 'all' }, review: { interval: 4, maxRequestsPerReview: 8 } },
  };
  output.inputBindings.push({ kind: 'task_output', name: 'Notes', sourceNodeId: 'editor' });
  let draft = draftFromDefinition(definition);
  for (const [i, binding] of output.inputBindings.entries()) {
    assert(binding.sourceNodeId);
    const reviewed = setRequiredOutputReview(
      draft,
      output.id,
      binding.name,
      binding.sourceNodeId,
      messages.Inspector.requiredReviewLabels,
    );
    assert(reviewed.ok);
    draft = reviewed.draft;
    const result = draft.definition.nodes.find((node) => node.id === output.id);
    assert(result?.type === 'output');
    const gate = result.requiredReviews?.find((item) => item.bindingName === binding.name);
    const loop = draft.definition.nodes.find((node) => node.id === gate?.loopNodeId);
    assert(loop?.type === 'loop');
    loop.maxIterations = i + 2;
  }
  const summary = lines(draft.definition);
  expect(summary).toEqual(
    expect.arrayContaining([
      'The final result “Report” comes from Researcher.',
      'The final result “Notes” comes from Editor.',
      'Shared Outrider advice is set up for 2 selected workers.',
      'Artifact review is available on request.',
      'Automatic observation is set to every 4 model requests per worker.',
      '“Report” must pass review before submission. The round limit is 2.',
      '“Notes” must pass review before submission. The round limit is 3.',
    ]),
  );
  expect(summary).toHaveLength(7);
});

it('distinguishes whole-team advice from on-request artifact review and observation', () => {
  const { definition } = team();
  definition.sharedOutrider = shared;
  expect(lines(definition)).toEqual([
    'The final result “Report” comes from Researcher.',
    'Shared Outrider advice is set up for the whole team.',
    'On-request artifact review is off.',
    'Automatic observation is off.',
  ]);
});

it('labels an unsaved Outrider setup beside the heading and identifies saved versions separately', () => {
  const { definition } = team();
  definition.sharedOutrider = shared;
  const unsaved = summary(definition, null);
  expect(unsaved.querySelector('h3 + span')?.textContent).toBe('Includes unsaved changes');
  expect(unsaved.textContent).toContain('Shared Outrider advice is set up for the whole team.');
  expect(unsaved.textContent).not.toContain('Saved version');
  expect(summary(definition, 2).querySelector('h3 + span')?.textContent).toBe('Saved version 2');
});
