import type { MeetingParticipant } from '@corral/contracts';

// What a message itself says about who should answer. Only display names and aliases count, so the
// secretary is never addressed here. Anything unclear is left to the selector.

export interface MeetingAddress {
  /** Who the message asks; empty when it does not say. */
  participantIds: string[];
  /** Who the message rules out; nothing may call them for this message. */
  excluded: string[];
}

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const LETTER_BEFORE = '(?<![\\p{L}\\p{N}_])';
const JOIN = '\\s*(?:,|/|&|이랑|랑|하고|와|과|및|\\band\\b)\\s*';
const CLOSING = '\\s*[.!~ㅋㅎ]*$';

const LEAD_IN =
  /^(?:(?:그럼|그러면|그런데|근데|그래서|그리고|아니|자|음|저기|일단|우선|이번엔|이번에는|이제|또|야|hey|hi|hello|ok|okay|so|and|well|yo)[,\s]+)+/iu;
/** Calling someone outright: `솔아`, `루나 님`, `Sol,`, or the name alone. */
const VOCATIVE = /^(?:이?[야아](?=[\s,.:!?~]|$)|\s?(?:님|씨)(?=[\s,.:!?~]|$)|\s*[,:]|[\s?!.~]*$)/u;
const TOPIC = /^(?:이는|은|는|도)/u;
const TOLD_TO_ANSWER =
  /^(?:이|가|께서)?\s*(?:답해|답변해|답\s?좀|대답|말해|설명해|얘기해|이야기해|알려|정리해)/u;
const TOLD_TO_ANSWER_EN = /^\s+(?:what|how|why|do you|please|answer|tell|explain)\b/iu;
const QUESTION = new RegExp(
  `[?？]|(?:냐|니|나요|까|까요|가요|죠|어때|어떄|어떻게|어떤가)${CLOSING}`,
  'u',
);
const REQUEST = new RegExp(
  `(?:봐|봐라|봐요|줘|주세요|주라|해라|하세요|할래|답해|말해)${CLOSING}`,
  'u',
);
const OPINION = /어때|어떄|어떻|생각|의견|한마디|동의|찬성|반대|추천|답해|대답|말해/u;
const OPINION_EN =
  /\b(?:what|how|why|think|thoughts?|opinions?|agree|disagree|answer|recommend)\b/iu;

const asksGroup = (sentence: string) =>
  QUESTION.test(sentence) || OPINION.test(sentence) || OPINION_EN.test(sentence);
const asksSomeone = (sentence: string) => asksGroup(sentence) || REQUEST.test(sentence);

const EVERYONE_ANYWHERE = /각자|여러분|\b(?:everyone|everybody|all of you|each of you|you all)\b/iu;
const EVERYONE_FIRST = /^(?:다들|너희|너네|니들)/u;
const ALL_FIRST =
  /^모두(?:들)?\s*(?:[,:]|어때|어떄|어떻|생각|의견|답|한마디|동의|찬성|반대|말해|얘기)/u;
const THE_OTHERS = /나머지|다른\s*(?:사람|분)|\b(?:the others|the rest)\b/iu;

export function readMeetingAddress(
  text: string,
  participants: readonly Pick<MeetingParticipant, 'participantId' | 'name' | 'aliases'>[],
): MeetingAddress {
  const callings = participants
    .flatMap(({ participantId, name, aliases }) =>
      [name, ...(aliases ?? [])].map((calling) => ({
        participantId,
        calling: calling.normalize('NFC').toLowerCase(),
      })),
    )
    .sort((a, b) => b.calling.length - a.calling.length);
  const name = callings.map(({ calling }) => escaped(calling)).join('|');
  const chain = `(?:${name})(?:${JOIN}(?:${name}))*`;
  const idsIn = (written: string) => {
    const ids = new Set<string>();
    for (const [found] of written.toLowerCase().matchAll(new RegExp(name, 'giu')))
      ids.add(callings.find(({ calling }) => calling === found)!.participantId);
    return [...ids];
  };

  const ruledOut = new RegExp(
    [
      `${LETTER_BEFORE}${chain}\\s*(?:은|는|이|가|을|를|만|도)?\\s*(?:말고|빼고|빼면|제외(?:하고)?|없이)`,
      `${LETTER_BEFORE}${chain}\\s*(?:은|는|이|가)?\\s*(?:(?:대답|답|말)(?:하지|은\\s*하지)\\s*마\\S*|빠져\\S*)`,
      `\\b(?:except(?:\\s+for)?|other than|besides|but not)\\s+${chain}`,
    ].join('|'),
    'giu',
  );
  const message = text.normalize('NFC');
  const excluded = new Set<string>();
  for (const [found] of message.matchAll(ruledOut)) for (const id of idsIn(found)) excluded.add(id);
  // Everyone ruled out says nothing usable about who should answer.
  if (excluded.size >= participants.length) return { participantIds: [], excluded: [] };

  const startsWithChain = new RegExp(`^${chain}`, 'iu');
  const endsWithChain = new RegExp(`,\\s*(${chain})(?:이?[야아]|\\s?(?:님|씨))?[\\s?!.~]*$`, 'iu');
  const asked = new Set<string>();
  let everyone = false;
  const sentences = message
    .replace(ruledOut, (found) => (excluded.size ? ' ' : found))
    .split(/(?<=[.!?？！…])\s+|\n+/u);
  for (const whole of sentences) {
    const sentence = whole.trim().replace(LEAD_IN, '');
    if (!sentence) continue;
    if (
      (EVERYONE_ANYWHERE.test(sentence) && asksGroup(sentence)) ||
      (EVERYONE_FIRST.test(sentence) && asksGroup(sentence)) ||
      ALL_FIRST.test(sentence) ||
      (excluded.size > 0 && THE_OTHERS.test(sentence))
    )
      everyone = true;
    const first = startsWithChain.exec(sentence)?.[0];
    if (first) {
      const after = sentence.slice(first.length);
      const ids = idsIn(first);
      if (
        VOCATIVE.test(after) ||
        TOLD_TO_ANSWER.test(after) ||
        TOLD_TO_ANSWER_EN.test(after) ||
        (TOPIC.test(after) && asksSomeone(sentence)) ||
        (ids.length > 1 && asksSomeone(sentence))
      )
        for (const id of ids) asked.add(id);
    }
    const last = endsWithChain.exec(sentence)?.[1];
    if (last) for (const id of idsIn(last)) asked.add(id);
  }

  if ([...asked].some((id) => excluded.has(id)))
    return { participantIds: [], excluded: [...excluded] };
  const participantIds = participants
    .map(({ participantId }) => participantId)
    .filter((id) => !excluded.has(id) && (everyone || asked.has(id)));
  return { participantIds, excluded: [...excluded] };
}
