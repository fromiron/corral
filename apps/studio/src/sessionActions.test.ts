import type { RuntimeTransport } from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  advisorDefinition,
  advisorNodeId,
  advisorRunEvents,
  advisorRunProjection,
} from '../../../packages/react/src/stories/advisorRunFixture.ts';
import { steerTargets } from './sessionActions.ts';

// The review page sends feedback to one of these (features/advisor.md "보이는 곳": an Outrider is
// not among them). The fixture's advisor_1 is an Outrider still working beside impl_1: a saved
// team's, or the conversation's own (`session_advisor`).

describe.each([{ session: false }, { session: true }])('steer targets (%o)', (options) => {
  it('lists the working executions a person may instruct, never an Outrider', async () => {
    const projection = advisorRunProjection(advisorRunEvents(options));
    expect(projection.executions.advisor_1?.nodeId).toBe(advisorNodeId(options));
    const transport = {
      getSnapshot: async () => ({ projection, seq: 0 }),
      getRunDefinition: async () => advisorDefinition(options),
    } as unknown as RuntimeTransport;
    const targets = await steerTargets({ transport }, 'run_advisor');
    expect(targets.map((target) => target.id)).toEqual(['impl_1']);
  });
});
