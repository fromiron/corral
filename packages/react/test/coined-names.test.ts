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
      'A copy of the project kept for this conversation, fenced off so runs can work without touching the source folder.',
      '프로젝트 원본 폴더를 건드리지 않고 실행이 일하도록 이 대화에 따로 둔, 울타리 안의 사본입니다.',
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

describe('the retired screen names', () => {
  it.each(RETIRED)('no screen text says "%s"', (_word, pattern) => {
    const found: string[] = [];
    for (const catalog of [en, ko]) {
      for (const [key, value] of leaves(catalog as unknown as Tree)) {
        if (MODEL_FACING.has(key)) continue;
        // An argument's name ({advisor}) is code, not text.
        const text = value.replace(/\{\s*[A-Za-z_]\w*/g, '{');
        if (pattern.test(text)) found.push(`${key}: ${value}`);
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
