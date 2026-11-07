import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallCard, ToolCallGroup } from '../src/design-kit/index.ts';

const calls = [
  { id: 'a', name: 'search_web', status: 'success' as const, latencyMs: 1500 },
  { id: 'b', name: 'fetch_page', status: 'success' as const, latencyMs: 900 },
];

describe('tool calls inside a group', () => {
  it('lists each call as a flat row, not a raised card', () => {
    render(<ToolCallGroup calls={calls} />);
    for (const name of ['search_web', 'fetch_page']) {
      const row = screen.getByRole('button', { name: new RegExp(name) }).closest('[data-status]');
      expect(row?.className).not.toMatch(/(bg|shadow)-surface-/);
    }
  });

  it('keeps a call shown alone on its own card', () => {
    render(<ToolCallCard call={calls[0] as (typeof calls)[number]} />);
    const card = screen.getByRole('button', { name: /search_web/ }).closest('[data-status]');
    expect(card?.className).toMatch(/bg-surface-\d/);
  });
});
