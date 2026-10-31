import type { DecisionCancellation, MeetingSelectionInput, Scheduler } from '@corral/contracts';
import type { EffortEngine } from '../effort/provider.ts';

export const MEETING_PREPROCESS_VERSION = 'meeting-text-v1';
export interface MeetingWeights {
  schemaVersion: 1;
  version: string;
  dims: number;
  baseModelSha256: string;
  preprocessVersion: string;
  /** topic, followup, all, compare; separate from reasoning difficulty. */
  intent: { weights: number[][]; bias: number[] };
  rank: { weights: number[]; bias: number };
  allThreshold: number;
  minimumScore: number;
  minimumMargin: number;
}

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));
export function loadMeetingWeights(
  raw: unknown,
  expected: { dims: number; baseModelSha256: string },
): MeetingWeights {
  const w = raw as MeetingWeights;
  if (
    w?.schemaVersion !== 1 ||
    typeof w.version !== 'string' ||
    w.dims !== expected.dims ||
    w.baseModelSha256 !== expected.baseModelSha256 ||
    w.preprocessVersion !== MEETING_PREPROCESS_VERSION ||
    !Array.isArray(w.intent?.weights) ||
    w.intent.weights.length !== 4 ||
    !w.intent.weights.every((row) => numbers(row, expected.dims)) ||
    !numbers(w.intent.bias, 4) ||
    !numbers(w.rank?.weights, 6) ||
    !Number.isFinite(w.rank.bias) ||
    ![w.allThreshold, w.minimumScore, w.minimumMargin].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1,
    )
  )
    throw new Error('meeting weights do not match the embedding or selection format');
  return w;
}

/** IDs/names are not semantic features. Each slot remains present even if its text is empty. */
export function meetingTexts(input: MeetingSelectionInput): string[] {
  const clean = (text: string) => [...text.trim()].slice(0, 1800).join('');
  return [
    clean(input.message),
    ...input.participants.map((p) => clean(p.prompt)),
    ...input.participants.map((p) =>
      clean(input.history.findLast((h) => h.participantId === p.participantId)?.text ?? ''),
    ),
  ];
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};
const softmax = (values: number[]) => {
  const top = Math.max(...values),
    exp = values.map((v) => Math.exp(v - top));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / total);
};

export function meetingFeatures(
  input: MeetingSelectionInput,
  vectors: Float32Array[],
  weights: MeetingWeights,
) {
  if (
    vectors.length !== 1 + input.participants.length * 2 ||
    vectors.some((v) => v.length !== weights.dims || !v.every(Number.isFinite))
  )
    throw new Error('meeting embedding dimensions do not match');
  const query = vectors[0]!;
  const intent = softmax(
    weights.intent.weights.map((row, n) => dot(row, query) + weights.intent.bias[n]!),
  );
  const lastSpeaker = input.history.findLast((h) => h.participantId !== null)?.participantId;
  const texts = meetingTexts(input);
  const similarities = input.participants.map((p, n) => {
    const role = texts[n + 1] ? dot(query, vectors[n + 1]!) : 0;
    const reply = texts[n + 1 + input.participants.length]
      ? dot(query, vectors[n + 1 + input.participants.length]!)
      : 0;
    return { role, reply, last: Number(lastSpeaker === p.participantId) };
  });
  const average = (pick: (s: (typeof similarities)[number]) => number) =>
    similarities.reduce((sum, s) => sum + pick(s), 0) / similarities.length;
  const roleMean = average((s) => s.role),
    replyMean = average((s) => s.reply),
    bestMean = average((s) => Math.max(s.role, s.reply));
  const topical = intent[0]! + intent[3]!;
  const features = similarities.map(({ role, reply, last }) => {
    return [
      (reply - replyMean) * topical,
      (role - roleMean) * topical,
      (reply - replyMean) * intent[1]!,
      last * intent[1]!,
      (Math.max(role, reply) - bestMean) * topical,
      intent[3]!,
    ];
  });
  return { intent, features };
}

export function selectMeetingVectors(
  input: MeetingSelectionInput,
  vectors: Float32Array[],
  weights: MeetingWeights,
): string[] | null {
  const { intent, features } = meetingFeatures(input, vectors, weights);
  if (intent[2]! >= weights.allThreshold) return input.participants.map((p) => p.participantId);
  if (
    !input.participants.some((p) => p.prompt.trim()) &&
    !input.history.some((h) => h.participantId !== null && h.text.trim())
  )
    return null;
  const ranked = features
    .map((f, n) => ({
      id: input.participants[n]!.participantId,
      score: 1 / (1 + Math.exp(-(dot(f, weights.rank.weights) + weights.rank.bias))),
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const selected = ranked.filter((candidate) => candidate.score >= weights.minimumScore);
  const next = ranked[selected.length];
  return best &&
    selected.length &&
    selected[selected.length - 1]!.score - (next?.score ?? 0) >= weights.minimumMargin
    ? selected.map((candidate) => candidate.id)
    : null;
}

const realTimers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
export class LocalMeetingSelector {
  private readonly engine: EffortEngine;
  private readonly weights: MeetingWeights;
  private readonly timers: Scheduler;
  constructor(engine: EffortEngine, weights: MeetingWeights, timers: Scheduler = realTimers) {
    this.engine = engine;
    this.weights = weights;
    this.timers = timers;
  }

  async select(input: MeetingSelectionInput): Promise<string[] | null> {
    if (this.engine.available() !== true || input.participants.length < 2) return null;
    const abort = new AbortController();
    const stop = this.timers.after(1500, () => abort.abort());
    const cancellation: DecisionCancellation = {
      get aborted() {
        return abort.signal.aborted;
      },
      onCancel(fn) {
        abort.signal.addEventListener('abort', fn);
        return () => abort.signal.removeEventListener('abort', fn);
      },
    };
    try {
      const vectors: Float32Array[] = [];
      for (const text of meetingTexts(input)) {
        if (!text) {
          vectors.push(new Float32Array(this.weights.dims));
          continue;
        }
        const [vector] = await this.engine.embed(
          { texts: [text], task: 'classification', overflow: 'truncate', priority: 'meeting' },
          cancellation,
        );
        if (abort.signal.aborted || !vector) return null;
        vectors.push(vector);
      }
      return selectMeetingVectors(input, vectors, this.weights);
    } catch {
      return null;
    } finally {
      stop();
    }
  }
}
