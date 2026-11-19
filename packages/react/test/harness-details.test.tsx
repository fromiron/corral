import { RunEvent } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { HarnessDetails } from '../src/components/HarnessDetails.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';

it('shows the pinned resource, final context, payload and unmanaged call evidence', () => {
  const definition = linearCorral(['writer']);
  const envelope = {
    schemaVersion: '0.1',
    runId: 'run_1',
    recordedAt: '2026-10-18T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
  };
  const events = [
    {
      type: 'run.started',
      payload: {
        corralId: definition.id,
        definitionHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        mode: 'mock',
        modelProfiles: [],
        limits: definition.limits,
        harnesses: {
          writer_role: {
            binding: { profileId: 'writer', revision: 2 },
            snapshotHash: 'c'.repeat(64),
            piVersion: '1.3.0',
            policyRevision: 1,
            policy: 'trusted-native',
            resources: [
              {
                hash: 'd'.repeat(64),
                name: 'writing-pack',
                version: '1.0.0',
                kind: 'extension',
                required: true,
              },
              {
                hash: 'e'.repeat(64),
                name: 'installed-pack',
                version: '2.0.0',
                kind: 'skill',
                required: false,
                skillName: 'internal-writing',
                entry: 'skills/write/SKILL.md',
                skillMode: 'auto',
              },
              {
                hash: 'f'.repeat(64),
                name: 'previous-pack',
                version: '1.0.0',
                kind: 'skill',
                required: false,
                skillName: 'recorded-earlier',
                entry: 'skills/write/SKILL.md',
                skillMode: 'auto',
              },
            ],
            projectTools: {
              projectId: 'project',
              revision: 2,
              hash: 'c'.repeat(64),
              checkIds: [],
              lspServerIds: [],
              mcpServerIds: ['issues'],
            },
            allowedTools: ['echo', 'mcp__issues__search'],
            tools: [],
            diagnostics: [],
            layers: [
              { scope: 'role', binding: { profileId: 'writer', revision: 2 } },
              { scope: 'run', binding: { profileId: 'one-time', revision: 3 } },
            ],
          },
        },
      },
    },
    {
      type: 'model.request_recorded',
      executionId: 'exec_1',
      payload: {
        modelCallId: 'call_1',
        snapshotHash: 'c'.repeat(64),
        purpose: 'compaction',
        directiveIds: [],
        contextHash: 'e'.repeat(64),
        contextBytes: 123,
        sections: [{ name: 'skill_writing', source: 'skill', hash: 'f'.repeat(64), bytes: 20 }],
      },
    },
    {
      type: 'model.payload_recorded',
      executionId: 'exec_1',
      payload: { modelCallId: 'call_1', payloadHash: '1'.repeat(64), payloadBytes: 200 },
    },
    {
      type: 'tool.requested',
      executionId: 'exec_1',
      payload: { executionId: 'exec_1', toolCallId: 'tool_1', name: 'echo', validatedArgs: {} },
    },
    {
      type: 'tool.started',
      executionId: 'exec_1',
      payload: {
        executionId: 'exec_1',
        toolCallId: 'tool_1',
        effectId: 'effect_1',
        management: 'unmanaged_native',
      },
    },
  ].map((event, i) =>
    RunEvent.parse({ ...envelope, eventId: `event_${i}`, runSeq: i + 1, ...event }),
  );
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <HarnessDetails
        session={sessionStore({ runId: 'run_1', definition, events })}
        skillLabel={({ resourceHash, entry }) =>
          resourceHash === 'e'.repeat(64) && entry === 'skills/write/SKILL.md'
            ? 'Brand voice'
            : null
        }
      />
    </IntlProvider>,
  );
  expect(screen.getByText('writing-pack · 1.0.0')).toBeInTheDocument();
  const named = screen.getByText(/Brand voice/).closest('summary');
  if (!named || !(named.parentElement instanceof HTMLDetailsElement))
    throw Error('Missing skill disclosure');
  expect(named).toHaveTextContent(messages.Harness.auto);
  expect(named).not.toHaveTextContent(/internal-writing|installed-pack/);
  const details = named.parentElement;
  expect(details.open).toBe(false);
  fireEvent.click(named);
  expect(details.open).toBe(true);
  expect(within(details).getByText('internal-writing')).toBeInTheDocument();
  expect(within(details).getByText('e'.repeat(64))).toBeInTheDocument();
  expect(within(details).getByText('installed-pack · 2.0.0')).toBeInTheDocument();
  expect(screen.getByText(/recorded-earlier/, { selector: 'summary' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /writer · r2/ })).toBeInTheDocument();
  expect(screen.getByText(/compaction/)).toBeInTheDocument();
  expect(screen.getByText(/skill_writing/)).toBeInTheDocument();
  expect(screen.getByText('1'.repeat(64))).toBeInTheDocument();
  expect(screen.getByText(/echo.*Unmanaged native/)).toBeInTheDocument();
  expect(screen.getByText('Run · one-time · r3')).toBeInTheDocument();
  expect(screen.getByText('MCP connections: issues')).toBeInTheDocument();
  expect(screen.getByText('Allowed tool names: echo, mcp__issues__search')).toBeInTheDocument();
});
