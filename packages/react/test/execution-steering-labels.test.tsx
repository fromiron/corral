import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

// Every label the kit can show comes from its own `AgentSteeringLabels` interface, read from the
// source, so a label the kit adds later fails here until the Reins area names it too.
const kitSource = readFileSync(
  resolve(__dirname, '../src/design-kit/components/agent/agent-steering.tsx'),
  'utf8',
);
const KEYS = [
  ...(/export interface AgentSteeringLabels \{([^}]*)\}/s.exec(kitSource)?.[1] ?? '').matchAll(
    /^\s*(\w+):/gm,
  ),
].map((match) => match[1] as keyof AgentSteeringLabels);

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
      expect(KEYS.length).toBeGreaterThanOrEqual(17);
      for (const key of KEYS) expect(labels[key], key).toBeDefined();
      const said = strings(labels);
      if (locale === 'ko') for (const text of said) expect(text).toMatch(/[가-힣]/);
      // The glossary names these by other words: Give instruction, Join, Interrupt, Next request.
      for (const text of said) expect(text).not.toMatch(/steer|queue/i);
    },
  );
});
