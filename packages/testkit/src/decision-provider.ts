import type { DecisionCancellation, DecisionProvider, EffortQuestion } from '@corral/contracts';

export interface ScriptedDecisionOptions {
  id?: string;
  version?: string;
  privacy?: 'local' | 'external';
  timeoutMs?: number;
  /** Declared questions. Default: reasoning_effort v1. */
  questions?: DecisionProvider['questions'];
  /** True, or why the provider is unavailable. */
  available?: true | string;
  /** The raw answer (validated by the Coordinator), or a function of the question. */
  answer?: unknown | ((question: EffortQuestion) => unknown);
  /** Awaited before answering; tests pass a Gate to hold an answer back. */
  before?: (question: EffortQuestion, cancellation: DecisionCancellation) => Promise<void>;
}

/** Deterministic DecisionProvider for tests and the demo (`scripted@1`). */
export class ScriptedDecisionProvider implements DecisionProvider {
  readonly id: string;
  readonly version: string;
  readonly privacy: 'local' | 'external';
  readonly timeoutMs: number;
  readonly questions: DecisionProvider['questions'];
  readonly asked: EffortQuestion[] = [];
  private readonly options: ScriptedDecisionOptions;

  constructor(options: ScriptedDecisionOptions = {}) {
    this.options = options;
    this.id = options.id ?? 'scripted';
    this.version = options.version ?? '1';
    this.privacy = options.privacy ?? 'local';
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.questions = options.questions ?? [{ kind: 'reasoning_effort', version: 1 }];
  }

  available(): true | string {
    return this.options.available ?? true;
  }

  async decide(question: EffortQuestion, cancellation: DecisionCancellation): Promise<unknown> {
    this.asked.push(question);
    await this.options.before?.(question, cancellation);
    const answer = this.options.answer;
    if (typeof answer === 'function') return (answer as (q: EffortQuestion) => unknown)(question);
    return (
      answer ?? {
        answer: 'medium',
        probabilities: { low: 0.1, medium: 0.6, high: 0.25, xhigh: 0.05 },
        evidenceLevel: 'model_probability',
      }
    );
  }
}
