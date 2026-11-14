import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

// glossary.md, "고유한 이름": Harness, Paddock and Outrider are Corral's own names, the same Latin
// word in both languages, and the screen calls each concept by that one name.

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

describe('the hints of the coined names', () => {
  it.each([
    [
      'harness',
      'Harness',
      'The tack a role works in: the skills, extensions and tools it may use, saved as one set.',
      '역할에 채우는 마구입니다. 그 역할이 쓰는 스킬·확장·도구를 한 묶음으로 저장한 것입니다.',
    ],
    [
      'outrider',
      'Outrider',
      "A role that rides alongside: it watches another role's work and advises it. It does not do the work itself.",
      '곁에서 함께 달리는 역할입니다. 다른 역할의 일을 지켜보다가 조언하고, 일을 직접 하지는 않습니다.',
    ],
    [
      'paddock',
      'Paddock',
      'A copy of the project kept for one conversation, fenced off so its runs can work without touching the source folder.',
      '프로젝트 원본 폴더를 건드리지 않고 실행이 일하도록 대화마다 따로 두는, 울타리 안의 사본입니다.',
    ],
  ])('%s has its name and meaning in both languages', (id, name, enMeaning, koMeaning) => {
    const enTerms = en.Terms as unknown as Record<string, { name: string; meaning: string }>;
    const koTerms = ko.Terms as unknown as Record<string, { name: string; meaning: string }>;
    expect(enTerms[id]).toEqual({ name, meaning: enMeaning });
    expect(koTerms[id]).toEqual({ name, meaning: koMeaning });
  });

  it('keeps no hint under the retired ids', () => {
    for (const terms of [en.Terms, ko.Terms]) {
      expect(Object.keys(terms)).not.toContain('workStyle');
      expect(Object.keys(terms)).not.toContain('advisor');
    }
  });
});

/**
 * Text written for the model keeps the words the model's tool descriptions use (glossary.md,
 * "고유한 이름"): a role's duty is sent to the model as its instructions, so its "working copy" /
 * "작업 사본" stays.
 */
const MODEL_FACING = new Set([
  // The duty of the Implement preset's role, sent to the model as its instructions.
  'TeamTemplates.presets.implement.duty',
  // The duty of the bug-fix template's Fix role, sent to the model as its instructions.
  'TeamTemplates.templates.bug-fix.roles.fix.duty',
]);

const RETIRED: [string, RegExp][] = [
  ['work style', /work[ -]styles?/i],
  ['작업 방식', /작업 방식/],
  ['advisor', /\badvisors?\b/i],
  ['감독', /감독/],
  ['working copy', /working[ -]cop(?:y|ies)/i],
  ['작업 사본', /작업 사본/],
];

/**
 * The words of an ICU message a person reads: its text and the text of every select and plural
 * branch. An argument's name ({advisor}), its type and a branch's selector are code, not text.
 */
function screenText(message: string): string {
  let i = 0;
  let out = '';
  const text = (): void => {
    while (i < message.length && message[i] !== '}') {
      if (message[i] === '{') argument();
      else out += message[i++];
    }
    out += ' ';
  };
  const skipTo = (stop: string) => {
    while (i < message.length && !stop.includes(message[i] as string)) i++;
  };
  const argument = (): void => {
    i++; // {
    skipTo(',}'); // the argument's name
    if (message[i] === '}') {
      i++;
      return;
    }
    i++; // ,
    const type = /^\s*(\w+)\s*/.exec(message.slice(i));
    i += type?.[0].length ?? 0;
    if (!type || !['plural', 'select', 'selectordinal'].includes(type[1] as string)) {
      skipTo('}'); // number, date and time styles
      i++;
      return;
    }
    if (message[i] === ',') i++;
    while (i < message.length && message[i] !== '}') {
      skipTo('{}'); // a selector such as one, =0, other or offset:1
      if (message[i] === '{') {
        i++;
        text();
        i++; // }
      }
    }
    i++;
  };
  while (i < message.length) {
    text();
    if (message[i] === '}') out += message[i++];
  }
  return out;
}

describe('the retired screen names', () => {
  it('reads the words of every select and plural branch, but no argument name', () => {
    const says = (message: string) => RETIRED.some(([, pattern]) => pattern.test(screenText(message)));
    expect(says('{count, plural, one {Advisor} other {Advisors}}')).toBe(true);
    expect(says('{x, select, a {working copy} other {ok}}')).toBe(true);
    expect(says('{n, plural, offset:1 =0 {none} other {# 작업 사본}}')).toBe(true);
    expect(says('<isolate>{advisor}</isolate> advised {node}')).toBe(false);
    expect(says('{advisor, select, other {Outrider}}')).toBe(false);
  });

  it.each(RETIRED)('no screen text says "%s"', (_word, pattern) => {
    const found: string[] = [];
    for (const catalog of [en, ko]) {
      for (const [key, value] of leaves(catalog as unknown as Tree)) {
        if (MODEL_FACING.has(key)) continue;
        if (pattern.test(screenText(value))) found.push(`${key}: ${value}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('allows only keys that exist and still say a retired word', () => {
    const enLeaves = leaves(en as unknown as Tree);
    const koLeaves = leaves(ko as unknown as Tree);
    for (const key of MODEL_FACING) {
      const both = `${enLeaves.get(key)}\n${koLeaves.get(key)}`;
      expect(RETIRED.some(([, pattern]) => pattern.test(both))).toBe(true);
    }
  });
});
