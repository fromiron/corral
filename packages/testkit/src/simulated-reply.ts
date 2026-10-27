import type { AgentStartInput, MeetingMinutesDocument } from '@corral/contracts';

/** User-facing fixtures; diagnostic echoes remain the scripted adapter's test default. */
export function simulatedReply(_turn: number, input: AgentStartInput): string {
  if (input.role.id === 'participant' && input.role.name === 'Secretary') {
    const minutes: MeetingMinutesDocument = {
      issues: ['Simulation: review a proposal and hand it off to a work session.'],
      claims: [],
      agreements: [],
      remainingDissent: [],
      unverifiedFacts: ['No model was called. These example minutes do not establish agreement.'],
      candidates: [
        {
          candidateId: 'simulation_example',
          content: {
            goal: 'Try the meeting handoff in simulation',
            scope: ['Review and edit this example before adopting it.'],
            excludedScope: ['Actual model analysis or implementation'],
            acceptanceCriteria: ['A work session receives the decision you explicitly adopted.'],
            remainingDissent: [],
            evidence: [],
            risks: ['This fixed example does not evaluate your conversation.'],
            actions: ['Check the adopted decision in the target work session.'],
            rejectedAlternatives: [],
          },
        },
      ],
    };
    return JSON.stringify(minutes);
  }
  return `Simulated response from ${input.role.name}. No model was called. This example demonstrates the conversation flow; connect a model for an answer to your request.`;
}
