import type { CallSnapshotInput, DecisionCancellation } from '@corral/contracts';
import { FakeClock, FakeRoutingBackend, utf8Length } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import type { FrameMeter } from '../src/effort-routing/frame.ts';
import {
  type CallSnapshot,
  callSnapshot,
  effortQuestion,
  excerpt,
  packFrame,
  route,
} from '../src/effort-routing/index.ts';

// features/effort-routing.md#판정-입력, #frame과-예산: what reaches an engine.

const never: DecisionCancellation = { aborted: false, onCancel: () => () => {} };
const utf8 = utf8Length;
const question = effortQuestion(['low', 'medium', 'high', 'xhigh']);
const bytesMeter = (overhead = 0): FrameMeter & { calls: number } => {
  const meter = {
    calls: 0,
    kind: 'api-bounded' as const,
    countState: async (text: string) => {
      meter.calls++;
      return utf8(text);
    },
    countInput: async (state: string) => {
      meter.calls++;
      return utf8(state) + overhead;
    },
  };
  return meter;
};
const input = (extra: Partial<CallSnapshotInput> = {}): CallSnapshotInput => ({
  request: { text: 'Fix the failing parser test.' },
  requestImages: 0,
  previousAssistant: null,
  toolCalls: [],
  earlierReplies: [],
  presentQuestionIds: [],
  ...extra,
});
const call = (id: string, result: string | null, status = 'completed' as const) => ({
  toolCallId: id,
  name: 'bash',
  args: { text: `{"command":"step ${id}"}` },
  result: result === null ? null : { text: result },
  status: result === null ? ('pending' as const) : status,
});
const none = { directives: [], questions: [] };

async function pack(snapshot: CallSnapshot, meter: FrameMeter = bytesMeter()) {
  const result = await packFrame(snapshot, meter, question, never);
  if (result.kind !== 'packed') throw new Error(`insufficient: ${result.reason}`);
  return result.frame;
}

describe('the call snapshot and frame', () => {
  it('P02: keeps every tool call of the step and records what it left out', async () => {
    const calls = [1, 2, 3, 4, 5].map((n) => call(`c${n}`, `${'log line\n'.repeat(60)}end ${n}`));
    const frame = await pack(
      callSnapshot(
        input({ previousAssistant: { text: 'Run the five checks.' }, toolCalls: calls }),
        none,
      ),
    );
    for (const n of [1, 2, 3, 4, 5]) expect(frame.state).toContain(`tool call c${n} bash`);
    expect(frame.omittedIds.length + frame.truncatedIds.length).toBeGreaterThan(0);
    expect(frame.record.included + frame.record.omitted).toBe(1 + 1 + 10);
    expect(utf8(frame.state)).toBeLessThanOrEqual(2048);
  });

  it('P03: a long log and the previous diagnosis both keep real text', async () => {
    const diagnosis = `The parser drops the last token because the loop stops one early. ${'More detail. '.repeat(200)}`;
    const log = `${'noise\n'.repeat(400)}FAIL parser.test.ts expected 3 tokens, got 2`;
    const frame = await pack(
      callSnapshot(
        input({ previousAssistant: { text: diagnosis }, toolCalls: [call('c1', log)] }),
        none,
      ),
    );
    expect(frame.state).toContain('The parser drops the last token');
    expect(frame.state).toContain('expected 3 tokens, got 2');
    expect(frame.truncatedIds).toEqual(expect.arrayContaining(['assistant', 'result:c1']));
  });

  it('P04: compared sources go in together or the request lacks context', async () => {
    const contract = { id: 'result:contract', text: '{"field":"value"}' };
    const diff = { id: 'result:diff', text: '- old\n+ new' };
    const base = callSnapshot(
      input({
        toolCalls: [call('contract', contract.text), call('diff', diff.text)],
      }),
      none,
    );
    const compared: CallSnapshot = {
      ...base,
      relations: [{ kind: 'compare', members: [contract.id, diff.id] }],
    };
    const frame = await pack(compared);
    expect(frame.state).toContain(contract.text);
    expect(frame.state).toContain(diff.text);

    const big = callSnapshot(
      input({
        toolCalls: [call('contract', 'c'.repeat(1500)), call('diff', 'd'.repeat(1500))],
      }),
      none,
    );
    const over = await packFrame(
      { ...big, relations: [{ kind: 'compare', members: [contract.id, diff.id] }] },
      bytesMeter(),
      question,
      never,
    );
    expect(over).toMatchObject({ kind: 'insufficient', reason: 'required-content-over-budget' });

    const missing = await packFrame(
      { ...base, relations: [{ kind: 'compare', members: [contract.id, 'result:gone'] }] },
      bytesMeter(),
      question,
      never,
    );
    expect(missing).toMatchObject({ kind: 'insufficient', reason: 'comparison-operand-missing' });
  });

  it('P05: parent questions are part of what is judged, in full', async () => {
    const frame = await pack(
      callSnapshot(input(), {
        directives: [{ directiveId: 'd1', text: 'Keep the public API.' }],
        questions: [
          {
            questionId: 'q1',
            senderExecutionId: 'e2',
            body: 'Which file owns the parser?',
            artifactRefs: [],
            deadline: '2026-11-09T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(frame.state).toContain('## instruction d1\nKeep the public API.');
    expect(frame.state).toContain('## question q1 from e2\nWhich file owns the parser?');
  });

  it('P07: required content over the budget is never cut', async () => {
    const result = await packFrame(
      callSnapshot(input({ request: { text: 'r'.repeat(3000) } }), none),
      bytesMeter(),
      question,
      never,
    );
    expect(result).toMatchObject({ kind: 'insufficient', reason: 'required-content-over-budget' });
    const cut = await packFrame(
      callSnapshot(input({ request: { text: 'short', originalBytes: 90_000 } }), none),
      bytesMeter(),
      question,
      never,
    );
    expect(cut).toMatchObject({ kind: 'insufficient', reason: 'required-content-over-budget' });
  });

  it('P08: sources keep their order, IDs and recorded status', async () => {
    const frame = await pack(
      callSnapshot(
        input({
          previousAssistant: { text: 'Trying two commands.' },
          toolCalls: [call('a', 'ok'), call('b', 'boom', 'failed' as never), call('c', null)],
        }),
        none,
      ),
    );
    const order = [
      '## request',
      '## assistant',
      '## tool call a bash · completed',
      '## tool result a · completed',
      '## tool call b bash · failed',
      '## tool result b · failed',
      '## tool call c bash · pending',
    ].map((heading) => frame.state.indexOf(heading));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(frame.state).not.toMatch(/resolved|root cause/i);
  });

  it('an image-only request or no request is insufficient context', async () => {
    expect(
      await packFrame(
        callSnapshot(input({ request: null, requestImages: 1 }), none),
        bytesMeter(),
        question,
        never,
      ),
    ).toMatchObject({ reason: 'unsupported-modality' });
    expect(
      await packFrame(callSnapshot(input({ request: null }), none), bytesMeter(), question, never),
    ).toMatchObject({ reason: 'missing-request' });
  });

  it('checks the whole engine input apart from the state', async () => {
    const snapshot = callSnapshot(
      input({
        previousAssistant: { text: 'plan '.repeat(300) },
        toolCalls: [call('a', 'x'.repeat(1500))],
      }),
      none,
    );
    const frame = await pack(snapshot, bytesMeter(7000));
    expect(utf8(frame.state) + 7000).toBeLessThanOrEqual(8192);
    expect(frame.record.inputUnits).toBeLessThanOrEqual(8192);
  });

  it('gives up after 32 counts instead of counting forever', async () => {
    let calls = 0;
    // Units that never add up: every optional excerpt counts as far too large.
    const stubborn: FrameMeter = {
      kind: 'd1-exact',
      countState: async (text) => {
        calls++;
        return text.includes('## assistant') ? 401 : 10;
      },
      countInput: async () => {
        calls++;
        return 10;
      },
    };
    const result = await packFrame(
      callSnapshot(input({ previousAssistant: { text: 'plan '.repeat(400) } }), none),
      stubborn,
      question,
      never,
    );
    expect(result).toMatchObject({ kind: 'insufficient', reason: 'packing-budget-exhausted' });
    expect(calls).toBeLessThanOrEqual(32);
  });

  it('cuts at grapheme boundaries and keeps 60% head, 40% tail', () => {
    const text = `${'가나다라마바사\n'.repeat(40)}👩‍👩‍👧‍👦 끝`;
    const cut = excerpt(text, 300)!;
    expect(utf8(cut)).toBeLessThanOrEqual(300);
    expect(cut.startsWith('가나다라마바사')).toBe(true);
    expect(cut.endsWith('👩‍👩‍👧‍👦 끝')).toBe(true);
    expect(cut).toMatch(/\[… \d+ bytes omitted …\]/);
    expect(cut).not.toContain('�');
  });
});

describe('one judgment against the deadline', () => {
  const routeWith = (backend: FakeRoutingBackend, clock: FakeClock, snapshot?: CallSnapshot) =>
    route({
      routeId: 'route_1',
      engine: { kind: 'local', device: { kind: 'cpu', threads: 4 }, callerTimeoutMs: 1000 },
      backend,
      snapshot: snapshot ?? callSnapshot(input(), none),
      candidates: ['low', 'medium', 'high', 'xhigh'],
      clock,
      timers: clock,
      cancellation: never,
    });

  it('Busy falls back before any count', async () => {
    const clock = new FakeClock();
    const busy = new FakeRoutingBackend({ refuse: 'busy' });
    const outcome = await routeWith(busy, clock);
    expect(outcome).toMatchObject({ kind: 'fallback', reason: 'busy' });
    expect(busy.countCalls).toBe(0);
  });

  it('a count that never returns times out and starts no engine call', async () => {
    const clock = new FakeClock();
    const backend = new FakeRoutingBackend({ holdCounts: true });
    const pending = routeWith(backend, clock);
    await Promise.resolve();
    clock.advance(1000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'fallback', reason: 'timeout' });
    expect(backend.requests).toHaveLength(0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(backend.busy).toBe(false);
  });

  it('a late answer after the deadline is recorded, not applied', async () => {
    const clock = new FakeClock();
    const backend = new FakeRoutingBackend({ answer: 'hold', now: () => clock.monotonicMs() });
    const pending = routeWith(backend, clock);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    clock.advance(1000);
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: 'fallback', reason: 'timeout', effort: null });
    expect(backend.busy).toBe(true);
    clock.advance(500);
    backend.flights[0]!.respond({ choice: 'high' });
    backend.flights[0]!.settle();
    expect(await outcome.settled).toMatchObject({
      basis: 'native-response-complete',
      lateResult: true,
      lateSelected: 'high',
      physicalOccupiedMs: 1500,
    });
    expect(backend.busy).toBe(false);
  });

  it('a token count the engine disagrees with is not applied', async () => {
    const clock = new FakeClock();
    const backend = new FakeRoutingBackend({
      answer: (request) => ({ choice: 'low', inputTokens: request.inputUnits + 1 }),
    });
    expect(await routeWith(backend, clock)).toMatchObject({
      kind: 'fallback',
      reason: 'token-count-mismatch',
    });
  });

  it('a transport failure names its reason', async () => {
    const clock = new FakeClock();
    const backend = new FakeRoutingBackend({ answer: 'hold' });
    const pending = routeWith(backend, clock);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    backend.flights[0]!.fail('daemon-crash');
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'daemon-crash' });
  });
});
