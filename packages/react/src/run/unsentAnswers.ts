import { createContext } from 'react';
import type { StoreApi } from 'zustand';

// features/composer-flow.md 대기 요청과 넘겨받기. A run's store never knows its conversation, so
// the card's conversation is kept beside the store with what was typed.

export interface CarriedAnswer {
  sessionId: string;
  text: string;
}

/** The conversation whose request box takes what a question card leaves unsent; none outside one. */
export const AnswerDraftTarget = createContext<string | null>(null);

type Kept = Map<string, { sessionId: string | null; texts: Record<string, string> }>;
const keptBy = new WeakMap<StoreApi<unknown>, Kept>();
const listeners = new Set<(answer: CarriedAnswer) => void>();

function keptOf(store: StoreApi<unknown>): Kept {
  let kept = keptBy.get(store);
  if (!kept) {
    kept = new Map();
    keptBy.set(store, kept);
  }
  return kept;
}

export function keepUnsentAnswer(
  store: StoreApi<unknown>,
  requestId: string,
  sessionId: string | null,
  texts: Record<string, string>,
) {
  keptOf(store).set(requestId, { sessionId, texts });
}

export function unsentAnswer(store: StoreApi<unknown>, requestId: string) {
  return keptBy.get(store)?.get(requestId)?.texts ?? {};
}

export function settleUnsentAnswer(
  store: StoreApi<unknown>,
  requestId: string,
  outcome: 'answered' | 'closed',
) {
  const kept = keptBy.get(store);
  const answer = kept?.get(requestId);
  kept?.delete(requestId);
  if (outcome === 'answered' || !answer?.sessionId) return;
  const text = Object.values(answer.texts)
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) return;
  for (const listener of [...listeners])
    try {
      listener({ sessionId: answer.sessionId, text });
    } catch {
      // One failing listener must not keep the text from the others.
    }
}

export function onUnsentAnswer(listener: (answer: CarriedAnswer) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
