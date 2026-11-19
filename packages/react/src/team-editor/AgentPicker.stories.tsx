import type { LibraryAgent } from '@corral/contracts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, within } from 'storybook/test';
import { StudioStoresProvider } from '../context.tsx';
import { defaultAgentRole, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import { sessionStore } from '../stories/fixtures.tsx';
import { TeamEditor } from './TeamEditor.tsx';

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
function PickerStory({ initialStatus }: { initialStatus: 'ready' | 'failed' }) {
  const [status, setStatus] = useState(initialStatus);
  const editor = useMemo(() => createEditorStore(emptyDraft()), []);
  const session = useMemo(() => sessionStore(), []);
  return (
    <div className="h-dvh">
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
  );
}
const meta = {
  title: 'Team editor/Agent picker',
  component: PickerStory,
  args: { initialStatus: 'ready' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PickerStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProjectAgents: Story = {
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Add agent' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await expect(dialog.getByRole('textbox', { name: 'Find an agent' })).toHaveFocus();
    await expect(dialog.getByRole('button', { name: 'Newsletter writer' })).toBeVisible();
  },
};
export const RetryLibrary: Story = {
  args: { initialStatus: 'failed' },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Add agent' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await expect(dialog.getByRole('alert')).toHaveTextContent('Could not load your agents.');
    await userEvent.click(dialog.getByRole('button', { name: 'Retry' }));
    await expect(dialog.getByRole('button', { name: 'Newsletter writer' })).toBeVisible();
  },
};
