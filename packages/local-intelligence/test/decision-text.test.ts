import type { ReasoningInput } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  renderEffort as researchEffort,
  renderMeeting as researchMeeting,
} from '../../../tools/local-intelligence/research/data.ts';
import {
  compactMeetingInput,
  type DecisionMeetingSelectionInput,
  formatDecisionPrompt,
  renderEffort,
  renderMeeting,
  toEffortInput,
} from '../src/decision/text.ts';

describe('shared decision input text', () => {
  it('uses exactly the research renderer functions and preserves their existing bytes', () => {
    expect(researchEffort).toBe(renderEffort);
    expect(researchMeeting).toBe(renderMeeting);
    expect(
      renderEffort({
        goal: 'A goal',
        request: 'a request\nwith unicode 한글',
        previousRequest: 'old request',
        previousReply: 'old reply',
        stage: 'step',
        plan: 'step1\nstep2',
        tools: [{ name: 'test', args: '--run', status: 'failed', content: 'observed\noutput' }],
      }),
    ).toBe(
      'Task: choose the minimum reasoning effort for the NEXT coding response.\nStage: step\nCurrent request: a request\nwith unicode 한글\nOverall goal: A goal\nPrevious user request: old request\nPrevious reply: old reply\nCurrent plan: step1\nstep2\nTool 1: test; status: failed\nArguments: --run\nObserved output: observed\noutput',
    );
    const scene = {
      participants: [
        { id: 'p1', name: '아람', role: '' },
        { id: 'p2', name: '보람', role: 'reviewer' },
      ],
      message: '질문',
      turns: [
        { id: 't1', speakerId: null, text: 'start' },
        { id: 't2', speakerId: 'p2', text: 'reply', replyTo: 't1' },
      ],
    };
    expect(renderMeeting(scene, 'p2')).toBe(
      'Task: choose who should answer the current message in this group conversation.\nParticipants:\np1: 아람\np2: 보람; role: reviewer\nConversation in visible order:\n[t1] user: start\n[t2] p2 replies to t1: reply\nCurrent user message: 질문\nCandidate to judge: p2',
    );
    expect(() => renderMeeting(scene, 'p3')).toThrow('candidate is not a participant');
  });

  it('retains observed stage/tool status and never invents a previous reply or character cut', () => {
    const observed = {
      name: 'test',
      args: '--run',
      result: 'failure at line8',
      status: 'failed' as const,
    };
    const input: ReasoningInput = {
      kind: 'step',
      request: `${'context '.repeat(5_000)}TAIL`,
      prevRequest: 'previous request',
      prev: '',
      plan: 'inspect\nthen fix',
      step: 7,
      directiveIds: [],
      calls: [{ name: 'read', args: 'file.ts', result: 'observed content' }, observed],
    };
    const mapped = toEffortInput(input);
    expect(mapped.stage).toBe('step');
    expect(mapped.tools).toEqual([
      { name: 'read', args: 'file.ts', status: 'completed', content: 'observed content' },
      { name: 'test', args: '--run', status: 'failed', content: 'failure at line8' },
    ]);
    const text = renderEffort(mapped);
    expect(text).toContain(input.request);
    expect(text).toContain('Previous user request: previous request');
    expect(text).not.toContain('Previous reply:');
    expect(text).not.toContain('Overall goal:');
    expect(text).toContain('Current plan: inspect\nthen fix');
  });

  it('matches the Qwen3.5 thinking-disabled training frame and preserves whitespace', () => {
    expect(formatDecisionPrompt('effort', '  body\r\n한글  ')).toBe(
      '<|im_start|>system\nChoose the minimum useful reasoning effort for the NEXT coding response, not the total project. Return ONLY low, medium, high, or xhigh.<|im_end|>\n<|im_start|>user\n  body\r\n한글  <|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
    );
    expect(formatDecisionPrompt('meeting', 'body')).toBe(
      '<|im_start|>system\nSelect who should answer the current message. Return ONLY comma-separated participant IDs, or NONE for explicit silence. If any one responder is acceptable or the invitation is ambiguous, choose exactly one appropriate participant. Honor exclusions. Never infer capabilities from names.<|im_end|>\n<|im_start|>user\nbody<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n',
    );
  });

  it('matches the trained NFC tokenizer for decomposed filenames without mutating the source', () => {
    const source = { text: 'Compare café.txt and cafe\u0301.txt\r\n\t가' };
    const original = source.text;
    expect(formatDecisionPrompt('effort', source.text)).toBe(
      formatDecisionPrompt('effort', 'Compare café.txt and café.txt\r\n\t가'),
    );
    expect(source.text).toBe(original);
  });

  it('compacts only structured identities, preserves chronology/reply links, and leaves input unchanged', () => {
    const input: DecisionMeetingSelectionInput = {
      message: 'take a look at alphabet; alpha said @a yesterday',
      participants: [
        { participantId: 'a', name: 'Ari', prompt: 'take a look' },
        { participantId: 'alpha', name: 'Al', prompt: 'alphabet reviewer' },
      ],
      history: [
        { id: 'old-long-id-A', participantId: null, text: 'a question' },
        {
          id: 'old-long-id-B',
          participantId: 'alpha',
          text: 'alphabet proposal',
          replyTo: 'old-long-id-A',
        },
        { id: 'old-long-id-C', participantId: 'former-participant', text: 'older answer' },
        { id: 'old-long-id-D', participantId: 'a', text: 'take a look', replyTo: 'old-long-id-B' },
        { participantId: 'former-participant', text: 'confirmed answer' },
      ],
    };
    const before = structuredClone(input);
    const compact = compactMeetingInput(input);
    expect(compact.input.participants).toEqual([
      { id: 'p1', name: 'Ari', role: 'take a look' },
      { id: 'p2', name: 'Al', role: 'alphabet reviewer' },
    ]);
    expect(compact.input.message).toBe(input.message);
    expect(compact.input.turns).toEqual([
      { id: 't1', speakerId: null, text: 'a question' },
      { id: 't2', speakerId: 'p2', text: 'alphabet proposal', replyTo: 't1' },
      { id: 't3', speakerId: 'other1', text: 'older answer' },
      { id: 't4', speakerId: 'p1', text: 'take a look', replyTo: 't2' },
      { id: 't5', speakerId: 'other1', text: 'confirmed answer' },
    ]);
    expect([...compact.participantIds]).toEqual([
      ['p1', 'a'],
      ['p2', 'alpha'],
    ]);
    expect(input).toEqual(before);
    expect(renderMeeting(compact.input)).not.toContain('old-long-id');
    expect(renderMeeting(compact.input)).not.toContain('former-participant');
  });

  it('keeps every supplied completed turn and does not infer names or capabilities', () => {
    const input: DecisionMeetingSelectionInput = {
      message: 'Who proposed the first idea?',
      participants: [
        { participantId: 'long-id-one', prompt: '' },
        { participantId: 'long-id-two', prompt: '' },
      ],
      history: Array.from({ length: 30 }, (_, index) => ({
        id: `run-uuid-${index}`,
        participantId: index % 2 ? 'long-id-one' : 'long-id-two',
        text: `completed statement ${index}`,
      })),
    };
    const compact = compactMeetingInput(input);
    expect(compact.input.turns).toHaveLength(30);
    expect(compact.input.turns.map((turn) => turn.text)).toEqual(
      input.history.map((turn) => turn.text),
    );
    expect(compact.input.participants.map((p) => [p.name, p.role])).toEqual([
      ['', ''],
      ['', ''],
    ]);
  });
});
