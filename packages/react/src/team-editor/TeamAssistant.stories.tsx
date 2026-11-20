import type { TeamPlan } from '@corral/contracts';
import { draftFromPlan, type TeamWording } from '@corral/core';
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
                  plan: samplePlan(goal, wording),
                  reason:
                    locale === 'ko'
                      ? '제공한 자료를 바탕으로 팀이 소식지를 작성합니다.'
                      : 'The team can write the newsletter from your event notes.',
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
        await userEvent.click(region.getByRole('button', { name: t.options }));
        const alternatives = region.getByRole('radiogroup', { name: m.TeamDraft.patternLabel });
        // The accordion fades its body in while it expands: it is not visible on its first
        // frame, and Axe compares its settled colours.
        await waitFor(() => expect(alternatives).toBeVisible());
        const panel = alternatives.closest('[role="region"]')?.firstElementChild;
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
export const ProposalWithAlternatives = example('proposal', 'en');
export const ProposalWithAlternativesKorean = example('proposal', 'ko');
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
