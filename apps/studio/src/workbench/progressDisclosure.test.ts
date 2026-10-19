import { describe, expect, it } from 'vitest';
import { disclosureNeedsAttention, progressListOpen } from './progressDisclosure.ts';

describe('progress list disclosure', () => {
  it('stays open while the run is working and the person has not toggled it', () => {
    expect(progressListOpen(true, false, null)).toBe(true);
  });

  it('closes after an ordinary success when the person has not toggled it', () => {
    expect(progressListOpen(false, false, null)).toBe(false);
  });

  it('stays open after failure or cancellation when the person has not toggled it', () => {
    expect(progressListOpen(false, true, null)).toBe(true);
  });

  it('keeps a list the person opened', () => {
    expect(progressListOpen(false, false, true)).toBe(true);
  });

  it('keeps a list the person closed', () => {
    expect(progressListOpen(true, true, false)).toBe(false);
  });
});

describe('when the tool list still needs a look', () => {
  const quiet = {
    runStatus: 'succeeded',
    exposedExecutions: 0,
    tools: [{ status: 'requested', phase: 'finished', reason: null }],
  };

  it('closes after tools that finished cleanly', () => {
    expect(disclosureNeedsAttention(quiet)).toBe(false);
  });

  it('stays open when the run was interrupted or a tool effect was not settled', () => {
    expect(disclosureNeedsAttention({ ...quiet, runStatus: 'interrupted' })).toBe(true);
    expect(
      disclosureNeedsAttention({
        ...quiet,
        tools: [{ status: 'requested', phase: 'running', reason: null, effectOutcome: 'unknown' }],
      }),
    ).toBe(true);
    expect(
      disclosureNeedsAttention({
        ...quiet,
        tools: [
          { status: 'requested', phase: 'running', reason: null, effectOutcome: 'cancelled' },
        ],
      }),
    ).toBe(true);
  });
});
