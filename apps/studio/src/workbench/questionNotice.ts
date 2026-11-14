import { ExtensionUiRequest, UserInputRequest } from '@corral/contracts';
import type { InteractionView } from '@corral/core';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

export type WaitingQuestion = Exclude<InteractionView, { kind: 'approval' }>;

/** A waiting question's own words for a notice: its first line, shortened. */
export function questionTitle(question: WaitingQuestion, body: string | undefined): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const title =
    question.kind === 'question'
      ? UserInputRequest.safeParse(parsed).data?.questions[0]?.prompt
      : ExtensionUiRequest.safeParse(parsed).data?.title;
  const line = title?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!line) return null;
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

/**
 * The notice for waiting questions: the first one's title, with the count from two. It reads the
 * first question's body when `texts` lacks it; null until that text is read or when it has no
 * title, so the caller keeps its generic wording.
 *
 * `load` must be stable. It may store the text where `texts` reads it, or return it.
 */
export function useQuestionNotice(
  questions: readonly WaitingQuestion[],
  texts: Readonly<Record<string, string>>,
  load: (bodyRef: string) => Promise<unknown>,
): string | null {
  const tw = useTranslations('Widgets');
  const first = questions[0];
  const bodyRef = first?.event.payload.bodyRef;
  const known = bodyRef ? texts[bodyRef] : undefined;
  const [read, setRead] = useState<{ bodyRef: string; text: string } | null>(null);
  useEffect(() => {
    if (!bodyRef || known !== undefined) return;
    let current = true;
    load(bodyRef).then(
      (text) => {
        if (current && typeof text === 'string') setRead({ bodyRef, text });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [bodyRef, known, load]);
  if (!first) return null;
  const fetched = read && read.bodyRef === bodyRef ? read.text : undefined;
  const title = questionTitle(first, known ?? fetched);
  return title ? tw('questionTitle', { title, count: questions.length }) : null;
}
