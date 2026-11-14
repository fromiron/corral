import { createHash } from 'node:crypto';
import type {
  DecisionCancellation,
  MeetingSelectionInput,
  MeetingSelectorResult,
  Scheduler,
} from '@corral/contracts';
import type { EmbedRequest } from '../engine/engine.ts';

export const MEETING_PREPROCESS_VERSION = 'meeting-text-v2';
/** The share of a score that comes from name and role; the rest is the person's own turns. */
const ROLE_WEIGHT = 0.25;
/** Enough for a six-person meeting's roles and history several times over. */
const CACHED_VECTORS = 512;

const clean = (text: string) => [...text.trim()].slice(0, 1800).join('');

/** The message, then each participant's name, aliases, role and the turns they posted. */
export function meetingTexts(input: MeetingSelectionInput) {
  return {
    message: clean(input.message),
    participants: input.participants.map((person) => ({
      participantId: person.participantId,
      role: clean(
        [person.name, ...(person.aliases ?? []), person.role, person.prompt]
          .filter((part) => part?.trim())
          .join('\n'),
      ),
      turns: input.history
        .filter((turn) => turn.participantId === person.participantId)
        .map((turn) => clean(turn.text))
        .filter(Boolean),
    })),
  };
}

/**
 * Each participant's score from role and history similarity. Someone without turns has
 * `history: null` and stands on their role, or whoever spoke first would keep every turn. Who
 * answers is the meeting policy's call, not this one's.
 */
export function blendedScores(
  scores: { participantId: string; role: number; history: number | null }[],
): MeetingSelectorResult['scores'] {
  return scores.map(({ participantId, role, history }) => ({
    participantId,
    score: history === null ? role : ROLE_WEIGHT * role + (1 - ROLE_WEIGHT) * history,
  }));
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

/** The part of the embedding engine the selector uses. */
export interface MeetingEngine {
  available(): true | string;
  embed(request: EmbedRequest, cancellation?: DecisionCancellation): Promise<Float32Array[]>;
}

const realTimers: Scheduler = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class LocalMeetingSelector {
  private readonly engine: MeetingEngine;
  private readonly release: string;
  private readonly timers: Scheduler;
  /** Keyed by a hash so that no meeting text stays in memory; oldest use goes first. */
  private readonly vectors = new Map<string, Float32Array>();

  constructor(engine: MeetingEngine, release: string, timers: Scheduler = realTimers) {
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
      { texts: [text], task: 'classification', overflow: 'truncate' },
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

  /** Scores only; this selector reports no `needsReply`, so it never asks for silence. */
  async select(input: MeetingSelectionInput): Promise<MeetingSelectorResult | null> {
    if (this.engine.available() !== true || input.participants.length < 2) return null;
    const { message, participants } = meetingTexts(input);
    const described = (person: { prompt: string; role?: string }) =>
      Boolean(person.prompt.trim() || person.role?.trim());
    // Names and aliases alone do not say what someone can answer.
    if (
      !message ||
      (!input.participants.some((person) => described(person)) &&
        !participants.some((person) => person.turns.length))
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
      for (const [index, { participantId, role, turns }] of participants.entries()) {
        const roleScore = role ? await similarity(role) : 0;
        const turnScores = [];
        for (const turn of turns) turnScores.push(await similarity(turn));
        scores.push({
          participantId,
          // A name or alias alone says nothing about what someone can answer.
          role: turns.length || described(input.participants[index]!) ? roleScore : 0,
          history: turnScores.length ? Math.max(...turnScores) : null,
        });
      }
      return abort.signal.aborted ? null : { scores: blendedScores(scores) };
    } catch {
      return null;
    } finally {
      stop();
    }
  }
}
