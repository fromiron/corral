import type { ExecutionStatus, RunStatus } from '@corral/contracts';
import { render } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import {
  PresenceBadge,
  PresenceDot,
  PresenceLabel,
  presenceBadgeColor,
  presenceDotClass,
  presenceTextClass,
} from '../src/components/PresenceBadge.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { executionPresence, type Presence, runPresence } from '../src/run/presence.ts';

// docs/specs/features/presence.md: a state's colour comes from its tone alone, the same in a dot,
// a mark and a badge; the kit glyph gives only the shape.

const run = (status: RunStatus) => runPresence({ status }, [], []);
const execution = (status: ExecutionStatus) => executionPresence({ status });
const wrap = (node: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      {node}
    </IntlProvider>,
  ).container;

const TONES = [
  ['neutral', 'bg-muted-foreground/60', 'text-muted-foreground/60', 'gray'],
  ['active', 'bg-primary', 'text-primary', 'gray'],
  ['success', 'bg-success', 'text-success', 'green'],
  ['warning', 'bg-warning', 'text-warning', 'amber'],
  ['danger', 'bg-danger', 'text-danger', 'red'],
] as const;

describe('tone to colour', () => {
  it.each(TONES)('a %s state is %s, %s and a %s badge', (tone, dot, text, badge) => {
    expect(presenceDotClass(tone)).toContain(dot);
    expect(presenceTextClass(tone)).toBe(text);
    expect(presenceBadgeColor(tone)).toBe(badge);
  });

  it('draws a dot in its tone, named only when asked', () => {
    const failed = wrap(<PresenceDot presence={run('failed')} label />);
    const dot = failed.querySelector('[role="img"]');
    expect(dot?.getAttribute('aria-label')).toBe('Failed');
    expect(dot?.className).toContain('bg-danger');
    const quiet = wrap(<PresenceDot presence={run('paused')} />);
    expect(quiet.querySelector('[aria-hidden="true"]')?.className).toContain('bg-warning');
    expect(quiet.querySelector('[role="img"]')).toBeNull();
  });
});

describe('badge', () => {
  const badge = (presence: Presence, target?: `run:${string}` | `execution:${string}`) =>
    wrap(<PresenceBadge presence={presence} {...(target ? { target } : {})} />);

  it.each([
    ['failed', '#ef4444'],
    ['paused', '#f59e0b'],
    ['succeeded', '#22c55e'],
  ] as const)('tints a %s badge by its tone (%s)', (status, hex) => {
    const container = badge(run(status));
    const tinted = container.querySelector<HTMLElement>(`[data-presence="${status}"]`);
    expect(tinted?.getAttribute('style') ?? '').toContain(hex);
  });

  it('colours its glyph by the tone, never the kit’s own colour', () => {
    const container = badge(run('failed'));
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('style')).toBeNull();
    expect(svg?.parentElement?.className).toContain('text-danger');
  });

  it('labels the state name alone with its target; the detail stands beside it', () => {
    const container = badge(execution('waiting_children'), 'execution:x');
    const label = container.querySelector('[data-presence-label="execution:x"]');
    expect(label?.textContent).toBe('Working');
    expect(container.textContent).toContain('Working· Waiting for agents');
    expect(badge(run('running')).querySelector('[data-presence-label]')).toBeNull();
  });
});

describe('label', () => {
  it('colours its glyph by the tone and keeps the detail out of the label', () => {
    const container = wrap(
      <PresenceLabel presence={execution('waiting_message')} target="execution:y" />,
    );
    expect(container.querySelector('[data-presence-label="execution:y"]')?.textContent).toBe(
      'Working',
    );
    expect(container.textContent).toContain('Working · Waiting for a reply');
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('style')).toBeNull();
    expect(svg?.parentElement?.className).toContain('text-primary');
  });
});
