import type { LibraryAgent } from '@corral/contracts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { StudioStoresProvider } from '../context.tsx';
import { defaultAgentRole, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import en from '../messages/en.json' with { type: 'json' };
import ko from '../messages/ko.json' with { type: 'json' };
import { sessionStore } from '../stories/fixtures.tsx';
import { TeamEditor } from './TeamEditor.tsx';

const catalogs = { en, ko };
type Locale = keyof typeof catalogs;
type Status = 'ready' | 'failed';
const writer: LibraryAgent = {
  agentId: 'writer',
  projectId: 'newsletter',
  revision: 3,
  role: defaultAgentRole(
    'Newsletter writer',
    'Write this week’s edition from the approved events.',
  ),
  archivedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};
function PickerStory({ initialStatus, locale }: { initialStatus: Status; locale: Locale }) {
  const [status, setStatus] = useState(initialStatus);
  const editor = useMemo(() => createEditorStore(emptyDraft()), []);
  const session = useMemo(() => sessionStore(), []);
  return (
    <IntlProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
      <div lang={locale} className="h-dvh">
        <StudioStoresProvider editor={editor} session={session}>
          <TeamEditor
            view="composition"
            editor={editor}
            agentLibrary={{
              status,
              agents: status === 'ready' ? [writer] : [],
              projectName: 'Newsletter',
              retry: () => setStatus('ready'),
            }}
          />
        </StudioStoresProvider>
      </div>
    </IntlProvider>
  );
}
const meta = {
  title: 'Team editor/Agent picker',
  component: PickerStory,
  args: { initialStatus: 'ready', locale: 'en' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PickerStory>;
export default meta;
type Story = StoryObj<typeof meta>;
function example(initialStatus: Status, locale: Locale): Story {
  const t = catalogs[locale].TeamEditor.agentPicker;
  return {
    args: { initialStatus, locale },
    play: async ({ canvasElement, userEvent }) => {
      await userEvent.click(within(canvasElement).getByRole('button', { name: t.add }));
      const popup = await within(canvasElement.ownerDocument.body).findByRole('dialog');
      const dialog = within(popup);
      await expect(dialog.getByRole('textbox', { name: t.search })).toHaveFocus();
      if (initialStatus === 'failed') {
        await expect(dialog.getByRole('alert')).toHaveTextContent(t.failed);
        await userEvent.click(dialog.getByRole('button', { name: t.retry }));
      }
      await expect(dialog.getByRole('button', { name: writer.role.name })).toBeVisible();
      // Axe measures the kit's settled colours, not a frame of the dialog's entrance fade.
      await waitFor(() => expect(getComputedStyle(popup).opacity).toBe('1'));
    },
  };
}
export const ProjectAgents = example('ready', 'en');
export const ProjectAgentsKorean = example('ready', 'ko');
export const RetryLibrary = example('failed', 'en');
export const RetryLibraryKorean = example('failed', 'ko');
