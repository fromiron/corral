import { createTranslator } from 'use-intl';
import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// The Korean catalog (roadmap UX-A5): same keys as English, same arguments, valid ICU.

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [p, v] of leaves(value, path)) out.set(p, v);
  }
  return out;
}

/**
 * Argument names of an ICU message: `{name}` and `{name, type, …}` at text level, and the
 * arguments inside plural/select option bodies. Option bodies themselves are text, not names.
 */
function parseIcu(message: string): { names: string[]; text: string } {
  const names = new Set<string>();
  let plain = '';
  let i = 0;
  const text = (): void => {
    while (i < message.length && message[i] !== '}') {
      if (message[i] === '{') argument();
      else plain += message[i++];
    }
    plain += ' ';
  };
  const argument = (): void => {
    i++; // {
    const name = /^\s*([A-Za-z_]\w*)\s*/.exec(message.slice(i));
    if (!name) return;
    names.add(name[1] as string);
    i += name[0].length;
    if (message[i] === '}') {
      i++;
      return;
    }
    i++; // ,
    const type = /^\s*(\w+)\s*/.exec(message.slice(i));
    i += type?.[0].length ?? 0;
    if (type && ['plural', 'select', 'selectordinal'].includes(type[1] as string)) {
      if (message[i] === ',') i++;
      while (i < message.length && message[i] !== '}') {
        if (message[i] === '{') {
          i++;
          text();
          i++; // }
        } else i++;
      }
      i++;
      return;
    }
    // number/date/time with an optional style: skip to the closing brace.
    while (i < message.length && message[i] !== '}') i++;
    i++;
  };
  while (i < message.length) {
    text();
    i++;
  }
  return { names: [...names].sort(), text: plain };
}

const argumentsOf = (message: string) => parseIcu(message).names;

const sample = (message: string) =>
  Object.fromEntries(
    argumentsOf(message).map((name) => [
      name,
      new RegExp(`\\{\\s*${name}\\s*,\\s*(plural|number)`).test(message) ? 2 : 'x',
    ]),
  );

const enLeaves = leaves(en as Tree);
const koLeaves = leaves(ko as Tree);

describe('Korean messages (UX-A5)', () => {
  it('[TC-UX-001-H] has every English key and no other', () => {
    expect([...koLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  it('[TC-UX-001-H] uses the same arguments as English in every message', () => {
    const mismatched = [...enLeaves].filter(
      ([key, message]) =>
        argumentsOf(message).join() !== argumentsOf(koLeaves.get(key) ?? '').join(),
    );
    expect(mismatched.map(([key]) => key)).toEqual([]);
  });

  it('[TC-UX-001-N] every Korean message formats without an ICU error and is not left in English', () => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: 'ko',
      messages: ko,
      onError: (error) => errors.push(error.message),
    });
    for (const [key, message] of koLeaves) {
      (t as unknown as (k: string, v: Record<string, unknown>) => string)(key, sample(message));
    }
    expect(errors).toEqual([]);
    // Text that should be translated: anything with a lowercase English word of 4+ letters
    // outside placeholders, except product terms and technical tokens.
    // models.dev names the catalog source; translating its domain would hide attribution.
    // `auto` is the team selector's name for Corral's automatic team (CR-055).
    const allowed =
      /\b(auto|Corral|Corrals|Run|Reins|Loop|Coordinator|Research|Writer|Reviewer|Helper|Source|Responder|JSON|corral|json|config|revision|control|http|Ctrl|Shift|Enter|codex|chmod|auth|models\.dev)\b/g;
    const untranslated = [...koLeaves].filter(([, message]) =>
      /\b[a-z]{4,}\b/.test(parseIcu(message).text.replace(allowed, '')),
    );
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });
});
