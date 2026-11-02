import { createHash } from 'node:crypto';
import type { DecisionCancellation, MeetingSelectionInput, Scheduler } from '@corral/contracts';
import type { EffortEngine } from '../effort/provider.ts';

export const MEETING_PREPROCESS_VERSION = 'meeting-text-v2';
/** The share of a score that comes from name and role; the rest is the person's own turns. */
const ROLE_WEIGHT = 0.25;
/** Enough for a six-person meeting's roles and history several times over. */
const CACHED_VECTORS = 512;

const clean = (text: string) => [...text.trim()].slice(0, 1800).join('');

/** The message, then each participant's name and role and the turns they actually posted. */
export function meetingTexts(input: MeetingSelectionInput) {
  return {
    message: clean(input.message),
    participants: input.participants.map((person) => ({
      participantId: person.participantId,
      role: clean([person.name, person.prompt].filter(Boolean).join('\n')),
      turns: input.history
        .filter((turn) => turn.participantId === person.participantId)
        .map((turn) => clean(turn.text))
        .filter(Boolean),
    })),
  };
}

/** One participant by role and history similarity; a tie keeps the roster order. */
export function closestParticipant(
  scores: { participantId: string; role: number; history: number }[],
): string {
  const blended = scores.map(
    ({ role, history }) => ROLE_WEIGHT * role + (1 - ROLE_WEIGHT) * history,
  );
  return scores[blended.indexOf(Math.max(...blended))]!.participantId;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

const realTimers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class LocalMeetingSelector {
  private readonly engine: EffortEngine;
  private readonly release: string;
  private readonly timers: Scheduler;
  /** Keyed by a hash so that no meeting text stays in memory; oldest use goes first. */
  private readonly vectors = new Map<string, Float32Array>();

  constructor(engine: EffortEngine, release: string, timers: Scheduler = realTimers) {
    this.engine = engine;
    this.release = release;
    this.timers = timers;
  }

  private async vector(text: string, cancellation: DecisionCancellation) {
    const key = createHash('sha256')
      .update(`classification\0${MEETING_PREPROCESS_VERSION}\0${this.release}\0${text}`)
      .digest('hex');
    const known = this.vectors.get(key);
    if (known) {
      this.vectors.delete(key);
      this.vectors.set(key, known);
      return known;
    }
    const [vector] = await this.engine.embed(
      { texts: [text], task: 'classification', overflow: 'truncate', priority: 'meeting' },
      cancellation,
    );
    if (!vector || !vector.every(Number.isFinite)) throw new Error('unusable meeting embedding');
    this.vectors.set(key, vector);
    if (this.vectors.size > CACHED_VECTORS) {
      for (const oldest of this.vectors.keys()) {
        this.vectors.delete(oldest);
        break;
      }
    }
    return vector;
  }

  async select(input: MeetingSelectionInput): Promise<string[] | null> {
    if (this.engine.available() !== true || input.participants.length < 2) return null;
    const { message, participants } = meetingTexts(input);
    // Nothing but display names tells ordinary participants apart.
    if (
      !message ||
      (!input.participants.some((p) => p.prompt.trim()) &&
        !participants.some((p) => p.turns.length))
    )
      return null;
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
      const query = await this.vector(message, cancellation);
      const similarity = async (text: string) => dot(query, await this.vector(text, cancellation));
      const scores = [];
      for (const { participantId, role, turns } of participants) {
        const roleScore = role ? await similarity(role) : 0;
        const turnScores = [];
        for (const turn of turns) turnScores.push(await similarity(turn));
        scores.push({
          participantId,
          role: roleScore,
          history: turnScores.length ? Math.max(...turnScores) : 0,
        });
      }
      return abort.signal.aborted ? null : [closestParticipant(scores)];
    } catch {
      return null;
    } finally {
      stop();
    }
  }
}
