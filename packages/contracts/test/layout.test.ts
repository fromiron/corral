import { describe, expect, it } from 'vitest';
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
import { CanvasLayout } from '../src/index.ts';

describe('CanvasLayout', () => {
  it('accepts the example layout', () => {
    expect(CanvasLayout.safeParse(researchLayout).success).toBe(true);
  });

  it('rejects execution fields inside a layout', () => {
    const doc = JSON.parse(JSON.stringify(researchLayout)) as Record<string, any>;
    doc.nodes.research.prompt = 'moved here by mistake';
    expect(CanvasLayout.safeParse(doc).success).toBe(false);
  });
});
