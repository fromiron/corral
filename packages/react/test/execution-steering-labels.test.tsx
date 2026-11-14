import { emptyProjection } from '@corral/core';
import { render } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AgentSteeringLabels } from '../src/design-kit/components/agent/agent-steering.tsx';
import enMessages from '../src/messages/en.json' with { type: 'json' };
import koMessages from '../src/messages/ko.json' with { type: 'json' };
import type { RunSessionState } from '../src/run/session.ts';

// The kit ships English default labels ("Steer the agent", "Queue for the next step", …). The
// Reins area must name everything it shows or reads aloud from the messages, in both languages.
const captured: { labels?: Partial<AgentSteeringLabels> } = {};
vi.mock('../src/design-kit/components/agent/agent-steering.tsx', () => ({
  AgentSteering: (props: { labels?: Partial<AgentSteeringLabels> }) => {
    captured.labels = props.labels;
    return null;
  },
}));

const { ExecutionSteering } = await import('../src/components/ExecutionSteering.tsx');

function session() {
  const projection = emptyProjection('run_1');
  projection.status = 'running';
  projection.executions = {
    exec_writer: { executionId: 'exec_writer', status: 'active', modelProfile: 'writer' },
  } as never;
  return createStore<RunSessionState>(
    () =>
      ({
        runId: 'run_1',
        projection,
        artifactTexts: {},
        streams: {},
        events: [],
        loadArtifact: vi.fn(),
      }) as unknown as RunSessionState,
  );
}

const KEYS: (keyof AgentSteeringLabels)[] = [
  'activity',
  'plan',
  'steps',
  'queued',
  'pause',
  'resume',
  'now',
  'remove',
  'instruction',
  'placeholder',
  'send',
  'nextHint',
  'interruptHint',
  'steered',
  'interrupted',
  'queuedAnnouncement',
  'interruptAnnouncement',
];

function strings(labels: Partial<AgentSteeringLabels>): string[] {
  return KEYS.map((key) => {
    const label = labels[key];
    if (typeof label === 'string') return label;
    if (key === 'steps') return (label as AgentSteeringLabels['steps'])(2, 5);
    return (label as (text: string) => string)('x');
  });
}

describe('ExecutionSteering labels', () => {
  it.each([
    ['en', enMessages],
    ['ko', koMessages],
  ] as const)(
    'passes every label the kit would otherwise default to English (%s)',
    (locale, catalog) => {
      captured.labels = undefined;
      render(
        <IntlProvider locale={locale} messages={catalog} timeZone="UTC">
          <ExecutionSteering
            session={session()}
            target={{ executionId: 'exec_writer', nodeLabel: 'Writer', finished: false }}
            compose={<div />}
          />
        </IntlProvider>,
      );
      const labels: Partial<AgentSteeringLabels> = captured.labels ?? {};
      for (const key of KEYS) expect(labels[key], key).toBeDefined();
      const said = strings(labels);
      if (locale === 'ko') for (const text of said) expect(text).toMatch(/[가-힣]/);
      // The glossary names these by other words: Give instruction, Join, Interrupt, Next request.
      for (const text of said) expect(text).not.toMatch(/steer|queue/i);
    },
  );
});
