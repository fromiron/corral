import type { TextDelta } from '@corral/contracts';
import type { RunProjection } from './projection.ts';
import type { RunStore } from './store/run-store.ts';

/** Private, incomplete display text. Never a result, event, or usage record. */
export interface PartialOutput {
  text: string;
  next: number;
  truncated: boolean;
}
export interface RuntimeSnapshot {
  projection: RunProjection;
  seq: number;
  partialOutputs?: Record<string, PartialOutput>;
}
const MAX_TEXT = 1_048_576;
const MAX_CHUNKS = 16_384;
const prefix = (id: string) => `stream:${encodeURIComponent(id)}:`;
const chunkRef = (id: string, index: number) => `${prefix(id)}${index}`;
const stopRef = (id: string) => `${prefix(id)}truncated`;

/** One writer per admitted model request; persistence precedes publication. */
export class PartialOutputWriter {
  private next = 0;
  private length = 0;
  private stopped = false;
  private readonly store: RunStore;
  private readonly runId: string;
  readonly modelCallId: string;
  constructor(store: RunStore, runId: string, modelCallId: string) {
    this.store = store;
    this.runId = runId;
    this.modelCallId = modelCallId;
  }
  append(delta: TextDelta): TextDelta | null {
    if (this.stopped || !Number.isSafeInteger(delta.chunkIndex) || delta.chunkIndex < this.next)
      return null;
    const stop = () => {
      this.store.putArtifactText(this.runId, stopRef(this.modelCallId), '1');
      this.stopped = true;
    };
    if (delta.chunkIndex !== this.next || this.next >= MAX_CHUNKS) {
      stop();
      return null;
    }
    let text = delta.text.slice(0, MAX_TEXT - this.length);
    // Do not persist half a surrogate pair at the storage boundary.
    if (text.length < delta.text.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const write = () =>
      this.store.putArtifactText(this.runId, chunkRef(this.modelCallId, this.next), text);
    // A normal fragment is one atomic insert. Only a shortened final fragment needs
    // a transaction with its marker; cloning an in-memory store per delta is quadratic.
    if (text.length < delta.text.length)
      this.store.transaction(() => {
        write();
        stop();
      });
    else write();
    this.next++;
    this.length += text.length;
    return { ...delta, text };
  }
}

export function readPartialOutputs(store: RunStore, runId: string, projection: RunProjection) {
  const outputs: Record<string, PartialOutput> = {};
  for (const call of Object.values(projection.modelCalls)) {
    if (call.responseRef) continue;
    const pieces: string[] = [];
    let length = 0;
    let next = 0;
    while (next < MAX_CHUNKS && length <= MAX_TEXT) {
      const text = store.getArtifactText(runId, chunkRef(call.modelCallId, next));
      if (text === null) break;
      pieces.push(text.slice(0, MAX_TEXT - length));
      length += text.length;
      next++;
    }
    if (next)
      outputs[call.modelCallId] = {
        text: pieces.join(''),
        next,
        truncated: store.getArtifactText(runId, stopRef(call.modelCallId)) !== null,
      };
  }
  return Object.keys(outputs).length ? outputs : undefined;
}
