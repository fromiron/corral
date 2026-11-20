import type { TeamComposition, TeamPlan } from '@corral/contracts';
import {
  BUILTIN_AGENTS,
  BUILTIN_SKILLS,
  draftFromPlan,
  ROLE_PRESET_IDS,
  type RolePresetId,
  roleFromPreset,
  type TeamWording,
} from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { StudioStoresProvider } from '../context.tsx';
import { draftFromDefinition, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import en from '../messages/en.json' with { type: 'json' };
import ko from '../messages/ko.json' with { type: 'json' };
import { sessionStore } from '../stories/fixtures.tsx';
import type { TeamAssistantHost } from './TeamAssistant.tsx';
import { TeamEditor } from './TeamEditor.tsx';

const catalogs = { en, ko };
type Scene =
  | 'opening'
  | 'question'
  | 'answered'
  | 'proposal'
  | 'stale'
  | 'failure'
  | 'offline'
  | 'demo'
  | 'edit'
  | 'goal';
type Locale = keyof typeof catalogs;

const editing = (scene: Scene) => scene === 'edit' || scene === 'goal';

/** The plan a model might answer for a goal: a planner, a writer and a reviewer. */
function samplePlan(brief: string, wording: TeamWording): TeamPlan {
  const { planner, writer, reviewer } = wording.roles;
  return {
    name: brief.slice(0, 40),
    brief,
    pattern: 'write_review',
    criteria: [wording.criteria.direct],
    roles: [
      { slot: 'planner', ...planner },
      { slot: 'writer', ...writer },
      { slot: 'reviewer', ...reviewer },
    ],
    reviewRounds: 1,
    finalApproval: false,
  };
}

type Messages = (typeof catalogs)[Locale];

/** What the editor could pick by hand: the built-in agents, then one skill. */
function storyChoices(messages: Messages): Awaited<ReturnType<TeamAssistantHost['choices']>> {
  return {
    agents: ROLE_PRESET_IDS.map((id) => {
      const { id: _id, ...role } = roleFromPreset(id, id, messages.TeamTemplates.presets[id].name);
      const description = BUILTIN_AGENTS.find((agent) => agent.id === id)?.description;
      return {
        role,
        origin: { kind: 'preset', presetId: id },
        builtin: true,
        ...(description ? { description } : {}),
      };
    }),
    skills: BUILTIN_SKILLS.filter((skill) => skill.name === 'doc-writing').map((skill) => ({
      ref: { resourceHash: skill.resourceHash, entry: skill.entry },
      name: skill.name,
      description: skill.description,
    })),
  };
}

/** The catalog id the editor gives a built-in agent in the request. */
const agent = (id: RolePresetId) => `a${ROLE_PRESET_IDS.indexOf(id) + 1}`;

/**
 * A team a model might compose for a newsletter: a researcher, two writers side by side, then an
 * editor whose issue a reviewer passes or sends back.
 */
function composedTeam(brief: string, locale: Locale): TeamComposition {
  const ko = locale === 'ko';
  return {
    name: brief.slice(0, 40),
    brief,
    criteria: [ko ? '모든 행사에 날짜와 장소를 적는다.' : 'Every event has a date and a place.'],
    seats: [
      {
        id: 'r',
        agent: agent('researcher'),
        name: ko ? '행사 조사' : 'Event research',
        duty: ko ? '이번 주 동네 행사를 모은다.' : 'Collect this week’s neighborhood events.',
      },
      {
        id: 'x',
        agent: agent('writer'),
        name: ko ? '행사 소개' : 'Event blurbs',
        duty: ko ? '행사마다 두 문장으로 소개한다.' : 'Describe each event in two sentences.',
      },
      {
        id: 'y',
        agent: agent('writer'),
        name: ko ? '교통 안내' : 'Getting there',
        duty: ko ? '행사장까지 가는 길을 적는다.' : 'Write how to reach each venue.',
      },
      {
        id: 'e',
        agent: agent('writer'),
        name: ko ? '소식지 편집' : 'Issue editor',
        duty: ko
          ? '소개와 안내를 한 호로 엮는다.'
          : 'Put the blurbs and directions into one issue.',
        skills: ['s1'],
      },
      {
        id: 'j',
        agent: agent('reviewer'),
        name: ko ? '발행 전 확인' : 'Final read',
        duty: ko ? '날짜와 장소가 맞는지 확인한다.' : 'Check every date and place.',
      },
    ],
    flow: [
      { seat: 'r' },
      { parallel: ['x', 'y'] },
      { loop: { work: ['e'], judge: 'j', rounds: 2 } },
    ],
  };
}

/** Only the request boundary is simulated. Play functions operate the mounted editor, including its undoable working copy. */
function AssistantStory({
  scene,
  locale,
  narrow,
  wide,
  asked,
}: {
  scene: Scene;
  locale: Locale;
  narrow: boolean;
  /** An editor wide enough for the conversation to stand in a column on its right. */
  wide: boolean;
  /** The host opens the conversation, as for a new team. Without it the place decides. */
  asked: boolean;
}) {
  const messages = catalogs[locale];
  const wording = messages.TeamDraft.wording;
  const editor = useMemo(() => {
    const draft = editing(scene)
      ? draftFromDefinition(
          draftFromPlan(
            samplePlan(messages.TeamAssistant.examples.compare, wording),
            'story',
            wording.labels,
          ).definition,
        )
      : emptyDraft('story', messages.Workspace.newName);
    return createEditorStore(draft);
  }, [scene, messages, wording]);
  const session = useMemo(() => sessionStore(), []);
  const host = useMemo<TeamAssistantHost>(
    () => ({
      wording,
      choices: async () => storyChoices(messages),
      modelLabel: 'Storybook',
      newOperationId: () => crypto.randomUUID(),
      // The browser demo has no model settings to open.
      ...(scene !== 'demo' && { onConnectModel: () => {} }),
      ask:
        scene === 'offline' || scene === 'demo'
          ? null
          : async (request) => {
              if (scene === 'failure') throw new TypeError('Connection closed');
              if (request.mode === 'edit')
                return { model: 'Storybook', reply: { kind: 'describe', topic: 'submitter' } };
              if ((scene === 'question' || scene === 'answered') && request.messages.length === 1) {
                return {
                  model: 'Storybook',
                  reply: { kind: 'question', id: 'material', choices: ['person', 'team'] },
                };
              }
              const goal = request.messages[0]?.content ?? messages.TeamAssistant.examples.guide;
              return {
                model: 'Storybook',
                reply: {
                  kind: 'plan',
                  plan: composedTeam(goal, locale),
                  reason:
                    locale === 'ko'
                      ? '두 작성자가 소개와 교통 안내를 나눠 쓰고, 발행 전에 날짜와 장소를 확인합니다.'
                      : 'Two writers split the blurbs and directions, and every date is checked before the issue goes out.',
                },
              };
            },
    }),
    [scene, locale, wording, messages],
  );
  return (
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <div
        lang={locale}
        className="h-dvh max-h-[52rem] bg-background text-foreground"
        style={wide ? { width: 1640 } : { maxWidth: narrow ? 390 : 1280 }}
      >
        <StudioStoresProvider editor={editor} session={session}>
          <TeamEditor
            editor={editor}
            assistant={host}
            assistantStart={asked ? { open: true } : undefined}
            view="composition"
            stacked={narrow}
          />
        </StudioStoresProvider>
      </div>
    </IntlProvider>
  );
}

const meta = {
  title: 'Team editor/Team assistant',
  component: AssistantStory,
  args: { locale: 'en', scene: 'opening', narrow: false, wide: false, asked: true },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AssistantStory>;
export default meta;
type Story = StoryObj<typeof meta>;

function example(scene: Scene, locale: Locale, narrow = false, wide = false): Story {
  return {
    args: { scene, locale, narrow, wide },
    play: async ({ canvasElement, userEvent }) => {
      const page = within(canvasElement.ownerDocument.body);
      const m = catalogs[locale];
      const t = m.TeamAssistant;
      const element = await page.findByRole(narrow ? 'dialog' : 'region', {
        name: editing(scene) ? t.editTitle : t.createTitle,
      });
      if (narrow) {
        await waitFor(() => expect(getComputedStyle(element).opacity).toBe('1'));
        const bounds = element.getBoundingClientRect();
        const viewport = canvasElement.ownerDocument.documentElement;
        const rem = Number.parseFloat(getComputedStyle(viewport).fontSize);
        await expect(bounds.width).toBeLessThanOrEqual(45 * rem + 1);
        await expect(bounds.left + bounds.width / 2).toBeCloseTo(viewport.clientWidth / 2, 0);
      }
      const region = within(element);
      if (scene === 'offline' || scene === 'demo') {
        // No model: the request is switched off. On a server its place opens the model settings.
        await expect(region.getByText(t.createPrompt)).toBeVisible();
        await expect(region.queryByRole('textbox')).toBeNull();
        await expect(region.queryByRole('button', { name: t.examples.newsletter })).toBeNull();
        const place = region.getByRole('button', {
          name: scene === 'demo' ? t.localServer : t.connect,
        });
        if (scene === 'demo') await expect(place).toHaveAttribute('aria-disabled', 'true');
        else await expect(place).not.toHaveAttribute('aria-disabled');
        return;
      }
      const input = region.getByRole('textbox', {
        name: editing(scene) ? t.editRequest : t.createRequest,
      });
      if (scene === 'goal') {
        const after =
          locale === 'ko'
            ? '두 도서관을 비교해 방문할 곳을 추천하세요.\n운영 시간을 확인하세요.\n대중교통 경로를 알려 주세요.\n이용료를 비교하세요.\n모든 정보의 출처를 남기세요.'
            : 'Compare the two libraries and recommend one to visit.\nCheck their opening hours.\nInclude transit directions.\nCompare the fees.\nCite a source for each detail.';
        await userEvent.click(region.getByRole('button', { name: t.choice.set_brief }));
        await userEvent.click(input);
        await userEvent.paste(after);
        await userEvent.click(region.getByRole('button', { name: t.send }));
        const [oldGoal, newGoal] = region.getAllByRole('definition');
        await expect(oldGoal).toHaveAttribute('title', t.examples.compare);
        await expect(newGoal).toHaveAttribute('title', after);
        await expect(region.getByRole('button', { name: t.apply })).toBeEnabled();
        return;
      }
      if (scene === 'edit') {
        await expect(region.getByRole('button', { name: t.choice.describe })).toBeVisible();
        return;
      }
      if (scene === 'opening') {
        await expect(region.getByText(t.createPrompt)).toBeVisible();
        return;
      }
      await userEvent.click(region.getByRole('button', { name: t.examples.newsletter }));
      await expect(input).toHaveValue(t.examples.newsletter);
      await userEvent.click(region.getByRole('button', { name: t.send }));
      if (scene === 'question' || scene === 'answered') {
        const choice = await region.findByRole('button', { name: t.choice.person });
        await expect(choice).toHaveAccessibleDescription(`Storybook · ${m.TeamDraft.askCost}`);
        if (scene === 'answered') {
          await userEvent.click(input);
          await userEvent.paste(t.examples.compare);
          await userEvent.click(choice);
          await expect(await region.findByRole('button', { name: t.apply })).toBeEnabled();
          await expect(input).toHaveValue(t.examples.compare);
          await expect(region.getByText(t.choice.person, { selector: 'p' })).toBeVisible();
        }
      } else if (scene === 'failure') {
        await expect(await region.findByRole('alert')).toHaveTextContent(t.logic.unknown);
      } else {
        const apply = await region.findByRole('button', { name: t.apply });
        // The seats in their flow: work in parallel, and a loop with its rounds.
        await expect(
          region.getByRole('list', { name: m.TeamEditor.composition.parallel }),
        ).toBeVisible();
        await expect(
          region.getByRole('list', {
            name: locale === 'ko' ? '최대 2회' : 'Up to 2 rounds',
          }),
        ).toBeVisible();
        await userEvent.click(region.getByRole('button', { name: t.options }));
        const observe = region.getByRole('switch', { name: m.TeamEditor.sharedOutrider.observe });
        // The accordion fades its body in while it expands: it is not visible on its first
        // frame, and Axe compares its settled colours.
        await waitFor(() => expect(observe).toBeVisible());
        await expect(observe).not.toBeChecked();
        const panel = observe.closest('[role="region"]')?.firstElementChild;
        await waitFor(() => expect(panel && getComputedStyle(panel).opacity).toBe('1'));
        if (scene === 'stale') {
          await userEvent.type(
            page.getByRole('textbox', { name: m.TeamEditor.fields.brief }),
            t.examples.compare,
          );
          await expect(region.getByText(t.stale)).toBeVisible();
          await expect(apply).toBeDisabled();
        } else await expect(apply).toBeEnabled();
      }
    },
  };
}

export const CreateOpening = example('opening', 'en');
export const CreateOpeningKorean = example('opening', 'ko');
export const MaterialQuestion = example('question', 'en');
export const MaterialQuestionKorean = example('question', 'ko');
export const AnsweredQuestion = example('answered', 'en');
export const AnsweredQuestionKorean = example('answered', 'ko');
export const ComposedProposal = example('proposal', 'en');
export const ComposedProposalKorean = example('proposal', 'ko');
export const ChangedWorkingCopy = example('stale', 'en');
export const ChangedWorkingCopyKorean = example('stale', 'ko');
export const UnconfirmedRequest = example('failure', 'en');
export const UnconfirmedRequestKorean = example('failure', 'ko');
export const NoModel = example('offline', 'en');
export const NoModelKorean = example('offline', 'ko');
export const BrowserDemo = example('demo', 'en');
export const BrowserDemoKorean = example('demo', 'ko');
export const EditChoices = example('edit', 'en');
export const EditChoicesKorean = example('edit', 'ko');
export const GoalChange = example('goal', 'en');
export const GoalChangeKorean = example('goal', 'ko');
export const NarrowQuestion = example('question', 'en', true);
export const NarrowQuestionKorean = example('question', 'ko', true);
export const WideProposal = example('proposal', 'en', false, true);
export const WideProposalKorean = example('proposal', 'ko', false, true);

/** A wide editor keeps the conversation in a column on its right, open or collapsed. */
export const WideSide: Story = {
  args: { scene: 'edit', wide: true },
  play: async ({ canvasElement, userEvent }) => {
    const page = within(canvasElement);
    const t = en.TeamAssistant;
    const box = (el: Element) => el.getBoundingClientRect();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const region = await page.findByRole('region', { name: t.editTitle });
    const frame = region.parentElement as HTMLElement;
    const list = page.getByRole('list', { name: 'Team composition' });
    const detail = page.getByRole('complementary', { name: en.TeamEditor.inspector });
    const input = () => within(region).getByRole('textbox', { name: t.editRequest });
    // Open, it is the editor's right column: as tall as the editor, the input at its foot.
    await expect(box(region).right).toBeCloseTo(box(frame).right, 0);
    await expect(box(region).height).toBeCloseTo(box(frame).height, 0);
    await expect(box(region).width).toBeGreaterThanOrEqual(22 * rem);
    await expect(box(region).width).toBeLessThanOrEqual(28 * rem);
    await expect(box(list).right).toBeLessThanOrEqual(box(detail).left);
    await expect(box(detail).right).toBeLessThanOrEqual(box(region).left);
    await expect(box(detail).bottom).toBeCloseTo(box(frame).bottom, 0);
    await expect(box(frame).bottom - box(input()).bottom).toBeLessThan(5 * rem);
    // Collapsed, a rail keeps the same edge, and nothing is left under the work area.
    await userEvent.click(input());
    await userEvent.keyboard('{Escape}');
    const entry = page.getByRole('button', { name: t.editTitle });
    await expect(entry).toHaveFocus();
    await expect(box(region).right).toBeCloseTo(box(frame).right, 0);
    await expect(box(region).width).toBeLessThanOrEqual(3 * rem);
    await expect(box(detail).bottom).toBeCloseTo(box(frame).bottom, 0);
    await userEvent.click(entry);
    await expect(input()).toHaveFocus();
  },
};

/** Nobody chose: the wide column opens by itself, and folds away with its room unless in use. */
export const WideOpensByItself: Story = {
  args: { scene: 'edit', wide: true, asked: false },
  play: async ({ canvasElement, userEvent }) => {
    const page = within(canvasElement);
    const t = en.TeamAssistant;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const editor = canvasElement.querySelector<HTMLElement>('[lang]') as HTMLElement;
    const region = await page.findByRole('region', { name: t.editTitle });
    const width = () => region.getBoundingClientRect().width;
    const input = () => page.queryByRole('textbox', { name: t.editRequest });
    const entry = () => page.queryByRole('button', { name: t.editTitle });
    // Open without being asked, and the focus stays where the person left it.
    await waitFor(() => expect(input()).toBeVisible());
    await expect(input()).not.toHaveFocus();
    await expect(entry()).toBeNull();
    // Unused, it folds into the line under the work area and comes back with the room.
    editor.style.width = '1280px';
    await waitFor(() => expect(entry()).toBeVisible());
    await expect(input()).toBeNull();
    editor.style.width = '1640px';
    await waitFor(() => expect(input()).toBeVisible());
    // In use, it stays open under the work area with what was typed and the focus.
    await userEvent.type(input() as HTMLElement, 'Keep this');
    editor.style.width = '1280px';
    await waitFor(() => expect(width()).toBeGreaterThan(28 * rem));
    await expect(input()).toHaveValue('Keep this');
    await expect(input()).toHaveFocus();
    editor.style.width = '1640px';
    await waitFor(() => expect(width()).toBeLessThanOrEqual(28 * rem));
    // Collapsing is the person's choice: it holds in both places.
    await userEvent.clear(input() as HTMLElement);
    await userEvent.click(page.getByRole('button', { name: t.collapse }));
    await waitFor(() => expect(entry()).toHaveFocus());
    await expect(width()).toBeLessThanOrEqual(3 * rem);
    editor.style.width = '1280px';
    await waitFor(() => expect(width()).toBeGreaterThan(28 * rem));
    await expect(input()).toBeNull();
    editor.style.width = '1640px';
    await waitFor(() => expect(width()).toBeLessThanOrEqual(3 * rem));
    await expect(input()).toBeNull();
  },
};
