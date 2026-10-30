// `local-model`: the effort judge on the shared embedding engine, as a Corral DecisionProvider.
// The apply path (decideRequest) and the observe path (decide) use the same classifier; the
// observe path only has the excerpt. The engine is owned and closed by the server.
import type {
  DecisionCancellation,
  DecisionProvider,
  EffortQuestion,
  ReasoningInput,
} from '@corral/contracts';
import type { EmbedRequest } from '../engine/engine.ts';
import type { EffortClassifier } from './classifier.ts';
import { effortText, requestInput } from './preprocess.ts';

export interface EffortEngine {
  available(): true | string;
  isReady(): boolean;
  warmUp(): Promise<void>;
  embed(request: EmbedRequest, cancellation?: DecisionCancellation): Promise<Float32Array[]>;
}

/** The engine request for one effort judgment. Training embeds its sample through it too. */
export function effortRequest(input: ReasoningInput): EmbedRequest {
  return {
    texts: [effortText(input)],
    task: 'classification',
    overflow: 'truncate',
    priority: 'effort',
  };
}

export class LocalEffortProvider implements DecisionProvider {
  readonly id = 'local-model';
  readonly privacy = 'local' as const;
  readonly questions = [{ kind: 'reasoning_effort' as const, version: 1 }];
  readonly version: string;
  private readonly engine: EffortEngine;
  private readonly classifier: EffortClassifier;

  constructor(options: { engine: EffortEngine; classifier: EffortClassifier; release: string }) {
    this.engine = options.engine;
    this.classifier = options.classifier;
    this.version = `${options.release}+${options.classifier.version}`;
  }

  /**
   * For the observe path: 1.5 s once the engine runs. Before that a judgment also waits for the
   * helper to start, so it is not counted as a timeout.
   */
  get timeoutMs(): number {
    return this.engine.isReady() ? 1_500 : 20_000;
  }

  available(): true | string {
    return this.engine.available();
  }

  warmUp(): Promise<void> {
    return this.engine.warmUp();
  }

  decide(question: EffortQuestion, cancellation: DecisionCancellation) {
    return this.judge(requestInput(question.input.excerpt), cancellation);
  }

  decideRequest(input: ReasoningInput, cancellation: DecisionCancellation) {
    return this.judge(input, cancellation);
  }

  private async judge(input: ReasoningInput, cancellation: DecisionCancellation) {
    if (input.kind === 'compaction') throw new Error('compaction requests are not judged');
    const [vector] = await this.engine.embed(effortRequest(input), cancellation);
    const judgment = this.classifier.judge(vector!);
    return {
      answer: judgment.answer,
      probabilities: judgment.probabilities,
      evidenceLevel: 'model_probability' as const,
      abstain: judgment.abstain,
    };
  }
}
