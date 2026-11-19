// @vitest-environment jsdom
import { ApiError } from '@corral/client';
import {
  type CorralDefinition,
  TEAM_PATTERNS,
  TEAM_SLOTS,
  type TeamPattern,
} from '@corral/contracts';
import { CHANGE_TOOLS, compileDefinition } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator, IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { TeamDraftDialog } from './TeamDraftDialog.tsx';
import { templateText } from './templates.ts';

// Goal → team draft (docs/specs/features/library.md): the plan editor offers eight patterns,
// and only the pattern decides tools and wiring.

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(async (_to: unknown) => {}),
  saved: [] as { definition: CorralDefinition }[],
  draftTeam: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => fixture.navigate }));
vi.mock('./services.tsx', () => ({
  useServices: () => ({
    live: true,
    models: { draftTeam: fixture.draftTeam },
    repository: {
      save: async (input: { definition: CorralDefinition }) => {
        fixture.saved.push(input);
        return { ok: true, record: { corralId: input.definition.id } };
      },
    },
  }),
}));

// jsdom has no layout or media queries; the kit's select measures and animates.
Element.prototype.getAnimations ??= () => [];
// The kit's switch captures the pointer while it is pressed.
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= (query) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixture.navigate.mockClear();
  fixture.draftTeam.mockReset();
  fixture.saved.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

type Messages = typeof en;

async function mount(messages: Messages = en, locale = 'en') {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <TeamDraftDialog onClose={() => {}} projectId="alpha" />
      </IntlProvider>,
    );
  });
  return container;
}

const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

async function type(field: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const prototype = Object.getPrototypeOf(field);
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(element: Element) {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
    for (const kind of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      element.dispatchEvent(
        kind.startsWith('pointer') ? new PointerEvent(kind, init) : new MouseEvent(kind, init),
      );
  });
  await settle();
}

const button = (name: string) => {
  const all = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const found =
    all.find((item) => item.textContent?.trim() === name) ??
    // A button's badge follows its name.
    all.find((item) => item.textContent?.trim().startsWith(name));
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const field = <T extends HTMLElement>(label: string): T => {
  const labelled = document.querySelector<T>(`[aria-label="${label}"]`);
  if (labelled) return labelled;
  const element = [...document.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const id = element?.getAttribute('for');
  const found = id ? document.getElementById(id) : null;
  if (!found) throw new Error(`no field ${label}`);
  return found as T;
};
const roleNames = () =>
  [...document.querySelectorAll<HTMLInputElement>('input[id*="-name-"]')].map(
    (input) => input.value,
  );

/** The library template each of the five template patterns is named after. */
const TEMPLATE_OF = {
  implement_review: 'implement-review',
  plan_implement_review: 'plan-implement-review',
  bug_fix: 'bug-fix',
  parallel_review: 'parallel-review',
  tech_decision: 'tech-decision',
} as const;
const templateOf = (pattern: TeamPattern) =>
  pattern in TEMPLATE_OF ? TEMPLATE_OF[pattern as keyof typeof TEMPLATE_OF] : null;

/**
 * The name a pattern has on the Library page: the template card's name for single and the five
 * templates; the two patterns without a card keep the draft's own names.
 */
function patternName(messages: Messages, pattern: TeamPattern): string {
  const t = createTranslator({ locale: 'en', messages });
  const id = pattern === 'single' ? 'starter' : templateOf(pattern);
  return id
    ? t(`Workspace.template.${id}.name` as never)
    : t(`TeamDraft.patterns.${pattern}` as never);
}

/** The criteria a pattern starts with in the dialog's wording. */
function expectedCriteria(messages: Messages, pattern: TeamPattern): string {
  const id = templateOf(pattern);
  const { direct, sources } = messages.TeamDraft.wording.criteria;
  const criteria = id
    ? templateText(messages).wording(id).criteria
    : pattern === 'single'
      ? [direct]
      : [direct, sources];
  return criteria.join('\n');
}

/** The role names the dialog's wording gives a pattern, in slot order. */
function expectedRoles(messages: Messages, pattern: TeamPattern): string[] {
  const id = templateOf(pattern);
  const roles = (
    id ? templateText(messages).wording(id).roles : messages.TeamDraft.wording.roles
  ) as Record<string, { name: string }>;
  return TEAM_SLOTS[pattern].map((slot) => roles[slot]?.name ?? '');
}

async function openPatterns(messages: Messages) {
  await press(field<HTMLButtonElement>(messages.TeamDraft.patternLabel));
  // The select opens on the next animation frame.
  await act(async () => new Promise((done) => setTimeout(done, 100)));
  return [...document.querySelectorAll('[role="option"]')];
}

async function choosePattern(messages: Messages, pattern: TeamPattern) {
  const option = (await openPatterns(messages)).find(
    (item) => item.textContent?.trim() === patternName(messages, pattern),
  );
  if (!option) throw new Error(`no option for ${pattern}`);
  await press(option);
  await act(async () => new Promise((done) => setTimeout(done, 400)));
}

const criteriaText = () => field<HTMLTextAreaElement>(en.TeamDraft.criteriaLabel).value;

describe('the plan editor’s patterns', () => {
  it('the eight pattern names exist and differ in both languages', () => {
    for (const messages of [en, ko] as Messages[]) {
      const names = TEAM_PATTERNS.map((pattern) => patternName(messages, pattern));
      expect(names.every((name) => name.length > 0 && !name.includes('.'))).toBe(true);
      expect(new Set(names).size).toBe(8);
      expect(messages.TeamDraft.patternLabel.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['en', en],
    ['ko', ko],
  ] as const)(
    'the select names the eight patterns as the Library’s template cards do (%s)',
    async (locale, messages) => {
      await mount(messages as Messages, locale);
      await type(field<HTMLTextAreaElement>(messages.TeamDraft.goalLabel), 'Write a launch note');
      await press(button(messages.TeamDraft.suggest));
      const options = (await openPatterns(messages as Messages)).map((item) =>
        item.textContent?.trim(),
      );
      expect(options).toEqual(
        TEAM_PATTERNS.map((pattern) => patternName(messages as Messages, pattern)),
      );
      const card = (id: string) =>
        (messages.Workspace.template as Record<string, { name: string }>)[id]?.name;
      expect(options[0]).toBe(card('starter'));
      for (const [index, id] of Object.values(TEMPLATE_OF).entries())
        expect(options[index + 3]).toBe(card(id));
      if (locale === 'ko')
        expect(options).toEqual([
          '단일 에이전트',
          '작성·검토',
          '조사·작성·검토',
          '구현·검토',
          '계획·구현·검토',
          '버그 수정',
          '병렬 코드 리뷰',
          '기술 결정',
        ]);
    },
  );

  it('a local bug-fix suggestion shows the investigation, fix and review roles without a model request', async () => {
    await mount(ko as Messages, 'ko');
    const goal = '로그인 후 가끔 흰 화면이 뜨는 버그가 있어. 원인을 찾아서 고쳐 줘';
    await type(field<HTMLTextAreaElement>(ko.TeamDraft.goalLabel), goal);
    await press(button(ko.TeamDraft.suggest));
    expect(field(ko.TeamDraft.patternLabel).textContent).toContain('버그 수정');
    expect(roleNames()).toEqual(['원인 조사', '수정', '검토']);
    expect(fixture.draftTeam).not.toHaveBeenCalled();
    await press(button(ko.TeamDraft.open));
    const definition = fixture.saved[0]?.definition;
    if (!definition) throw new Error('nothing saved');
    expect(compileDefinition(definition).ok).toBe(true);
    const changing = definition.roles.filter((role) =>
      role.allowedWorkTools.some((tool) => CHANGE_TOOLS.includes(tool as never)),
    );
    expect(changing.map((role) => [role.id, role.name])).toEqual([['fix', '수정']]);
    expect(definition.input.brief).toBe(goal);
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it('asks once for ambiguous review, confirms the Output and saves the same valid gate', async () => {
    await mount(ko as Messages, 'ko');
    await type(field<HTMLTextAreaElement>(ko.TeamDraft.goalLabel), '원고를 리뷰 후 제출');
    await press(button(ko.TeamDraft.suggest));
    expect(document.body.textContent).toContain(ko.TeamDraft.reviewQuestion);
    expect(button(ko.TeamDraft.open).disabled).toBe(true);
    await press(button(ko.TeamDraft.reviewRequired));
    const target = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="switch"]')).find(
        (el) =>
          document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ===
          ko.Inspector.requireReview,
      );
    expect(target()).toBeDefined();
    expect(button(ko.TeamDraft.open).disabled).toBe(true);
    expect(fixture.saved).toHaveLength(0);
    await press(target()!);
    expect(button(ko.TeamDraft.open).disabled).toBe(false);
    await press(button(ko.TeamDraft.open));
    const definition = fixture.saved[0]?.definition;
    if (!definition) throw Error('no confirmed team saved');
    const output = definition.nodes.find((n) => n.type === 'output');
    const item = output?.requiredReviews?.[0];
    expect(item).toBeDefined();
    expect(output?.inputBindings).toContainEqual(
      expect.objectContaining({ name: item?.bindingName, sourceNodeId: item?.sourceNodeId }),
    );
    expect(definition.sharedOutrider?.modelProfile).toBe('model-a');
    expect(output?.requireApproval).toBe(false);
    expect(compileDefinition(definition).diagnostics).toEqual([]);
  });

  it.each(['local', 'model'] as const)(
    'saves requested artifact review from the %s proposal',
    async (method) => {
      const goal =
        'Let the writer ask for manuscript review when needed and revise it before submitting.';
      fixture.draftTeam.mockResolvedValue({
        plan: {
          name: 'Manuscripts',
          pattern: 'single',
          brief: goal,
          criteria: ['The manuscript includes the approved changes.'],
          roles: [{ slot: 'worker', name: 'Writer', duty: 'Revise and submit the manuscript.' }],
          finalApproval: false,
          outrider: 'artifact_review',
        },
        model: { provider: 'openai', modelId: 'gpt-test' },
      });
      await mount();
      await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), goal);
      await press(button(method === 'local' ? en.TeamDraft.suggest : en.TeamDraft.ask));
      expect(document.body.textContent).toContain(en.TeamDraft.artifactAdvice);
      await press(button(en.TeamDraft.open));
      const definition = fixture.saved[0]?.definition;
      expect(definition?.sharedOutrider).toMatchObject({
        targets: { kind: 'all' },
        artifactReview: true,
      });
      expect(definition?.nodes.map((node) => node.type)).toEqual(['agent', 'output']);
      expect(compileDefinition(definition).ok).toBe(true);
    },
  );

  it.each([
    [
      '고객용 안내문을 쓰고 필요할 때 같은 전문가에게 자문을 요청해 주세요.',
      'tech_decision',
      'consultation',
    ],
    [
      '원고의 오류는 작성자가 고치고 원할 때 초안 리뷰를 요청하게 해줘.',
      'implement_review',
      'artifact_review',
    ],
  ] as const)(
    'keeps an on-demand Korean goal free of added workflow (%s)',
    async (goal, pattern, outrider) => {
      fixture.draftTeam.mockResolvedValue({
        plan: {
          name: '모델 제안',
          pattern,
          brief: goal,
          criteria: ['요청을 충족하기'],
          roles: TEAM_SLOTS[pattern].map((slot) => ({ slot, name: slot, duty: '결과 만들기' })),
          ...(pattern === 'implement_review' ? { reviewRounds: 2 } : {}),
          finalApproval: false,
          outrider,
        },
        model: { provider: 'test', modelId: 'fake' },
      });
      await mount(ko as Messages, 'ko');
      await type(field<HTMLTextAreaElement>(ko.TeamDraft.goalLabel), goal);
      await press(button(ko.TeamDraft.ask));
      expect(roleNames()).toHaveLength(1);
      expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/로컬 제안/);
      await press(button(ko.TeamDraft.open));
      expect(fixture.saved[0]?.definition.nodes.map((node) => node.type)).toEqual([
        'agent',
        'output',
      ]);
    },
  );

  it('shows a localized preview when a returned model answer cannot be parsed for an on-demand goal', async () => {
    fixture.draftTeam.mockRejectedValue(
      new ApiError(
        502,
        'MODEL_UNAVAILABLE',
        "the model's answer was not a usable team plan; use the local suggestion",
      ),
    );
    await mount(ko as Messages, 'ko');
    await type(
      field<HTMLTextAreaElement>(ko.TeamDraft.goalLabel),
      '보고서에 피드백이 필요할 때만 요청할 수 있게 해줘.',
    );
    await press(button(ko.TeamDraft.ask));
    expect(roleNames()).toHaveLength(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/로컬 제안/);
    await press(button(ko.TeamDraft.open));
    expect(fixture.saved[0]?.definition.sharedOutrider?.artifactReview).toBe(true);
  });

  it('keeps the model preview for a goal naming distinct roles', async () => {
    const goal =
      'Give a planner and a writer distinct roles. They can ask for expert advice when needed.';
    fixture.draftTeam.mockResolvedValue({
      plan: {
        name: 'Two roles',
        pattern: 'write_review',
        brief: goal,
        criteria: ['Produce the requested draft.'],
        roles: TEAM_SLOTS.write_review.map((slot) => ({ slot, name: slot, duty: 'Do your part.' })),
        reviewRounds: 2,
        finalApproval: false,
        outrider: 'consultation',
      },
      model: { provider: 'test', modelId: 'fake' },
    });
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), goal);
    await press(button(en.TeamDraft.ask));
    expect(roleNames()).toEqual(['planner', 'writer', 'reviewer']);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('leaves a request failure visible rather than choosing a local draft', async () => {
    const message = 'The model request failed; generate a new draft or use the local suggestion.';
    fixture.draftTeam.mockRejectedValue(new ApiError(502, 'MODEL_UNAVAILABLE', message));
    await mount();
    await type(
      field<HTMLTextAreaElement>(en.TeamDraft.goalLabel),
      'Let the writer ask for feedback on demand.',
    );
    await press(button(en.TeamDraft.ask));
    expect(roleNames()).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
  });

  it('choosing each pattern shows its roles and criteria and keeps the name and brief', async () => {
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), 'Write a launch note');
    await press(button(en.TeamDraft.suggest));
    await type(field<HTMLInputElement>(en.TeamDraft.nameLabel), 'Kept team');
    for (const pattern of [...TEAM_PATTERNS].reverse()) {
      await choosePattern(en, pattern);
      expect(field(en.TeamDraft.patternLabel).textContent, pattern).toContain(
        patternName(en, pattern),
      );
      expect(roleNames(), pattern).toEqual(expectedRoles(en, pattern));
      // Untouched criteria become the new pattern's defaults.
      expect(criteriaText(), pattern).toBe(expectedCriteria(en, pattern));
      expect(field<HTMLInputElement>(en.TeamDraft.nameLabel).value).toBe('Kept team');
      expect(field<HTMLTextAreaElement>(en.TeamDraft.briefLabel).value).toBe('Write a launch note');
    }
  }, 20_000);

  it('criteria typed by hand survive pattern changes and are saved', async () => {
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), 'Write a launch note');
    await press(button(en.TeamDraft.suggest));
    await type(field<HTMLTextAreaElement>(en.TeamDraft.criteriaLabel), 'My own check\nAnother one');
    await choosePattern(en, 'tech_decision');
    await choosePattern(en, 'bug_fix');
    expect(criteriaText()).toBe('My own check\nAnother one');
    expect(roleNames()).toEqual(expectedRoles(en, 'bug_fix'));
    await press(button(en.TeamDraft.open));
    expect(fixture.saved[0]?.definition.input.criteria).toEqual(['My own check', 'Another one']);
  }, 10_000);

  it('a new suggestion resets the edited mark', async () => {
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), 'Write a launch note');
    await press(button(en.TeamDraft.suggest));
    await type(field<HTMLTextAreaElement>(en.TeamDraft.criteriaLabel), 'My own check');
    await press(button(en.TeamDraft.back));
    await press(button(en.TeamDraft.suggest));
    expect(criteriaText()).toBe(expectedCriteria(en, 'write_review'));
    await choosePattern(en, 'tech_decision');
    expect(criteriaText()).toBe(expectedCriteria(en, 'tech_decision'));
  }, 10_000);

  it('criteria from a model answer are replaced by a pattern change', async () => {
    fixture.draftTeam.mockResolvedValue({
      plan: {
        name: 'Signup validation',
        pattern: 'implement_review',
        brief: 'Add input validation to the signup form.',
        criteria: ['The model wrote this check.'],
        roles: [
          { slot: 'implement', name: 'Builder', duty: 'Add the validation.' },
          { slot: 'review', name: 'Checker', duty: 'Check the change.' },
        ],
        reviewRounds: 2,
        finalApproval: false,
      },
      model: { provider: 'openai', modelId: 'gpt-test' },
    });
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), 'Add signup validation');
    await press(button(en.TeamDraft.ask));
    expect(criteriaText()).toBe('The model wrote this check.');
    await choosePattern(en, 'bug_fix');
    expect(criteriaText()).toBe(expectedCriteria(en, 'bug_fix'));
    expect(roleNames()).toEqual(expectedRoles(en, 'bug_fix'));
  }, 10_000);

  it('the approval is off for every pattern until the person turns it on; patterns without a review loop have no rounds', async () => {
    await mount();
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), 'Write a launch note');
    await press(button(en.TeamDraft.suggest));
    expect(document.querySelector(`[aria-label="${en.TeamDraft.rounds}"]`)).not.toBeNull();
    await choosePattern(en, 'tech_decision');
    const approval = () => document.querySelector<HTMLElement>('[role="switch"]');
    expect(approval()?.getAttribute('aria-checked')).toBe('false');
    expect(
      approval()?.hasAttribute('disabled') || approval()?.getAttribute('aria-disabled') === 'true',
    ).toBe(false);
    await press(approval() as HTMLElement);
    expect(approval()?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector(`[aria-label="${en.TeamDraft.rounds}"]`)).toBeNull();
    await choosePattern(en, 'parallel_review');
    expect(document.querySelector(`[aria-label="${en.TeamDraft.rounds}"]`)).toBeNull();
    await choosePattern(en, 'bug_fix');
    expect(document.querySelector(`[aria-label="${en.TeamDraft.rounds}"]`)).not.toBeNull();
  }, 10_000);

  it('a rejected model answer shows the failure and a retry, and keeps the goal', async () => {
    fixture.draftTeam.mockRejectedValue(
      new ApiError(502, 'MODEL_UNAVAILABLE', "the model's answer was not a usable team plan"),
    );
    await mount();
    const goal = 'Review the auth module for security issues without changing it';
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), goal);
    await press(button(en.TeamDraft.ask));
    expect(fixture.draftTeam).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.TeamDraft.unusable);
    expect(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel).value).toBe(goal);
    expect(document.querySelector(`[aria-label="${en.TeamDraft.patternLabel}"]`)).toBeNull();
    const retry = button(en.TeamDraft.retry);
    expect(retry.disabled).toBe(false);
    await press(retry);
    expect(fixture.draftTeam).toHaveBeenCalledTimes(2);
    const [first, second] = fixture.draftTeam.mock.calls.map((call) => call[1]?.operationId);
    expect(first).not.toBe(second);
    expect(fixture.saved).toEqual([]);
  });

  // The local suggestion says on its own button that it calls no model, instead of a sentence
  // under it explaining what the button does.
  it('marks the local suggestion button as making no model call', async () => {
    await mount();
    expect(button(en.TeamDraft.suggest).textContent).toContain(en.TeamDraft.noModelCall);
    expect(document.body.textContent).not.toContain('Picks a team shape');
  });

  it('says on the ask button what the request costs, with no sentence under it', async () => {
    await mount();
    expect(button(en.TeamDraft.ask).textContent).toContain(en.TeamDraft.askCost);
    expect(document.body.textContent).not.toContain('Uses one model request');
  });
});

it('the suggestion leaves the final approval off, and the person can turn it on', async () => {
  await mount();
  await type(
    field<HTMLTextAreaElement>(en.TeamDraft.goalLabel),
    'Compare SQLite and PostgreSQL for an internal tool',
  );
  await press(button(en.TeamDraft.suggest));
  const approval = () => document.querySelector<HTMLElement>('[role="switch"]');
  expect(approval()?.getAttribute('aria-checked')).toBe('false');
  await press(approval() as HTMLElement);
  expect(approval()?.getAttribute('aria-checked')).toBe('true');
  await press(button(en.TeamDraft.open));
  const saved = fixture.saved[0]?.definition;
  expect(saved?.nodes.find((node) => node.type === 'output')).toMatchObject({
    requireApproval: true,
  });
});

it.each(['local', 'model'] as const)(
  'previews and can turn off an independent observation proposal from %s before saving',
  async (source) => {
    await mount();
    const goal = 'Let workers ask for manuscript review when needed and watch work in progress.';
    await type(field<HTMLTextAreaElement>(en.TeamDraft.goalLabel), goal);
    fixture.draftTeam.mockResolvedValue({
      plan: {
        name: 'Invitation',
        pattern: 'single',
        brief: goal,
        criteria: ['Include venue.'],
        roles: [{ slot: 'worker', name: 'Writer', duty: 'Write an invitation.' }],
        finalApproval: false,
        outrider: 'artifact_review',
        observeWork: true,
      },
    });
    await press(button(source === 'local' ? en.TeamDraft.suggest : en.TeamDraft.ask));
    const toggle = () =>
      [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (item) =>
          document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent ===
          en.TeamEditor.sharedOutrider.observe,
      );
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain('model-a');
    expect(document.body.textContent).toContain('every 3');
    expect(document.body.textContent).toContain('additional model requests');
    expect(document.body.textContent).toContain(en.TeamDraft.artifactAdvice);
    expect(fixture.saved).toHaveLength(0);
    const enabled = toggle();
    if (!enabled) throw new Error('Missing observation setting');
    await press(enabled);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    await press(button(en.TeamDraft.open));
    expect(fixture.saved[0]?.definition.sharedOutrider).toMatchObject({ artifactReview: true });
    expect(fixture.saved[0]?.definition.sharedOutrider).not.toHaveProperty('observation');
  },
);
