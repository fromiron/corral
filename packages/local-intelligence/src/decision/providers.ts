import {
  type DecisionAnswer,
  type DecisionCancellation,
  type DecisionProvider,
  EFFORT_LEVELS,
  type EffortQuestion,
  type ReasoningInput,
} from '@corral/contracts';
import { requestInput } from '../effort/preprocess.ts';
import {
  compactMeetingInput,
  type DecisionMeetingSelectionInput,
  formatDecisionPrompt,
  renderEffort,
  renderMeeting,
  toEffortInput,
} from './text.ts';
import type {
  DecisionInput,
  DecisionLevel,
  DecisionRequestOptions,
  DecisionResult,
} from './types.ts';

export interface DecisionEngineLike {
  available(): true | string;
  isReady(): boolean;
  warmUp(): Promise<void>;
  decide(input: DecisionInput, options: DecisionRequestOptions): Promise<DecisionResult>;
}

export interface EffortCalibration {
  version: string;
  temperature: number;
  /** Only an explicitly calibrated threshold can request abstention. Omitted means false. */
  abstainBelow?: number;
}

export interface DecisionEffortProviderOptions {
  engine: DecisionEngineLike;
  release: string;
  calibration: EffortCalibration;
  /** Must match the selected trained input budget, normally 1024. No character clipping. */
  inputBudget: number;
  now?: () => number;
}

export interface DecisionMeetingSelectorOptions {
  engine: DecisionEngineLike;
  release: string;
  inputBudget: number;
  now?: () => number;
}

export type CalibratedEffortAnswer = DecisionAnswer & {
  probabilities: Record<DecisionLevel, number>;
};

function validBudget(inputBudget: number) {
  if (!Number.isSafeInteger(inputBudget) || inputBudget <= 128)
    throw new Error('decision input budget is invalid');
}

/** Opt-in provider. Calibration changes probabilities; policy-level protection stays in core. */
export class LocalDecisionEffortProvider implements DecisionProvider {
  readonly id = 'local-model';
  readonly privacy = 'local' as const;
  readonly questions = [{ kind: 'reasoning_effort' as const, version: 1 }];
  readonly timeoutMs = 3_000;
  readonly version: string;
  private readonly engine: DecisionEngineLike;
  private readonly calibration: EffortCalibration;
  private readonly inputBudget: number;
  private readonly now: () => number;

  constructor(options: DecisionEffortProviderOptions) {
    validBudget(options.inputBudget);
    const calibration = options.calibration;
    if (
      !calibration.version.trim() ||
      !Number.isFinite(calibration.temperature) ||
      calibration.temperature <= 0 ||
      (calibration.abstainBelow !== undefined &&
        (!Number.isFinite(calibration.abstainBelow) ||
          calibration.abstainBelow < 0 ||
          calibration.abstainBelow > 1))
    )
      throw new Error('decision calibration is invalid');
    this.engine = options.engine;
    this.calibration = { ...calibration };
    this.inputBudget = options.inputBudget;
    this.now = options.now ?? Date.now;
    this.version = `${options.release}+${calibration.version}`;
  }

  available(): true | string {
    return this.engine.available();
  }

  /** The engine owner supplies all non-sensitive trained-frame warmup requests. */
  warmUp(): Promise<void> {
    return this.engine.warmUp();
  }

  decide(
    question: EffortQuestion,
    cancellation: DecisionCancellation,
  ): Promise<CalibratedEffortAnswer> {
    return this.decideRequest(requestInput(question.input.excerpt), cancellation);
  }

  async decideRequest(
    input: ReasoningInput,
    cancellation: DecisionCancellation,
  ): Promise<CalibratedEffortAnswer> {
    if (input.kind === 'compaction') throw new Error('compaction requests are not judged');
    if (cancellation.aborted) throw new Error('local decision cancelled');
    if (this.engine.available() !== true) throw new Error('local decision engine unavailable');
    const deadlineMs = this.now() + this.timeoutMs;
    const result = await this.engine.decide(
      {
        op: 'effort',
        prompt: formatDecisionPrompt('effort', renderEffort(toEffortInput(input))),
        inputBudget: this.inputBudget,
      },
      { deadlineMs, cancellation },
    );
    if (cancellation.aborted) throw new Error('local decision cancelled');
    if (this.now() >= deadlineMs) throw new Error('local decision timed out');
    if (
      result?.op !== 'effort' ||
      !Array.isArray(result.logits) ||
      result.logits.length !== 4 ||
      result.logits.some((score) => typeof score !== 'number' || !Number.isFinite(score))
    )
      throw new Error('local decision result is invalid');
    // Shift before dividing to avoid positive overflow for small valid temperatures.
    const top = Math.max(...result.logits);
    const weights = result.logits.map((score) =>
      Math.exp((score - top) / this.calibration.temperature),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const values = weights.map((weight) => weight / total) as [number, number, number, number];
    const best = values.indexOf(Math.max(...values));
    const answer = EFFORT_LEVELS[best];
    if (!answer || values.some((value) => !Number.isFinite(value)))
      throw new Error('local decision result is invalid');
    const [low, medium, high, xhigh] = values;
    return {
      answer,
      probabilities: { low, medium, high, xhigh },
      evidenceLevel: 'model_probability',
      abstain:
        this.calibration.abstainBelow !== undefined &&
        Math.max(...values) < this.calibration.abstainBelow,
    };
  }
}

/** Compact model identities are restored only after the output is validated. */
export class LocalDecisionMeetingSelector {
  readonly version: string;
  private readonly engine: DecisionEngineLike;
  private readonly inputBudget: number;
  private readonly now: () => number;

  constructor(options: DecisionMeetingSelectorOptions) {
    validBudget(options.inputBudget);
    this.engine = options.engine;
    this.inputBudget = options.inputBudget;
    this.now = options.now ?? Date.now;
    this.version = options.release;
  }

  /** Prepares the shared engine using only its caller-supplied fixed warmup inputs. */
  warmUp(): Promise<void> {
    return this.engine.warmUp();
  }

  async select(input: DecisionMeetingSelectionInput): Promise<string[] | null> {
    try {
      if (this.engine.available() !== true) return null;
      if (!this.engine.isReady()) {
        // A short meeting deadline must not kill shared cold initialization.
        void this.warmUp().catch(() => {});
        return null;
      }
      const deadlineMs = this.now() + 1_500;
      const compact = compactMeetingInput(input);
      const result = await this.engine.decide(
        {
          op: 'meeting',
          prompt: formatDecisionPrompt('meeting', renderMeeting(compact.input)),
          participantIds: compact.input.participants.map((participant) => participant.id),
          inputBudget: this.inputBudget,
        },
        { deadlineMs },
      );
      if (
        this.now() >= deadlineMs ||
        result?.op !== 'meeting' ||
        !Array.isArray(result.participantIds) ||
        new Set(result.participantIds).size !== result.participantIds.length
      )
        return null;
      const ids: string[] = [];
      for (const alias of result.participantIds) {
        const id = compact.participantIds.get(alias);
        if (id === undefined) return null;
        ids.push(id);
      }
      return ids;
    } catch {
      return null;
    }
  }
}
