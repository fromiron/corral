import { draftFromPlan, planFromGoal, type TeamWording } from '@corral/core';
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
  | 'edit'
  | 'goal';
type Locale = keyof typeof catalogs;

const editing = (scene: Scene) => scene === 'edit' || scene === 'goal';

function samplePlan(brief: string, wording: TeamWording) {
  const plan = planFromGoal(brief, wording);
  if (!plan) throw new Error('A story needs a goal');
  return plan;
}

/** Only the request boundary is simulated. Play functions operate the mounted editor, including its undoable working copy. */
function AssistantStory({
  scene,
  locale,
  narrow,
}: {
  scene: Scene;
  locale: Locale;
  narrow: boolean;
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
      ask:
        scene === 'offline'
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
        style={{ maxWidth: narrow ? 390 : 1280 }}
      >
        <StudioStoresProvider editor={editor} session={session}>
          <TeamEditor
            editor={editor}
            assistant={host}
            assistantStart={{ open: true }}
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
  args: { locale: 'en', scene: 'opening', narrow: false },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AssistantStory>;
export default meta;
type Story = StoryObj<typeof meta>;

function example(scene: Scene, locale: Locale, narrow = false): Story {
  return {
    args: { scene, locale, narrow },
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
      if (scene === 'opening' || scene === 'offline') {
        await expect(region.getByText(t.createPrompt)).toBeVisible();
        if (scene === 'offline') await expect(region.getByText(t.noModel)).toBeVisible();
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
        await expect(alternatives).toBeVisible();
        // The accordion fades its body in while it expands. Axe compares its settled colours.
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
export const EditChoices = example('edit', 'en');
export const EditChoicesKorean = example('edit', 'ko');
export const GoalChange = example('goal', 'en');
export const GoalChangeKorean = example('goal', 'ko');
export const NarrowQuestion = example('question', 'en', true);
export const NarrowQuestionKorean = example('question', 'ko', true);
