import { Select } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { PANE_CATALOG } from '../panels/registry.ts';
import type { DockContextView } from './layout.ts';

export type PrimaryView = 'chat' | 'files' | 'changes' | 'run';
/** Where a pane is shown: the conversation, the 파일 tab's dock, the 변경 tab or a 실행 tab. */
export function primaryViewFor(view: DockContextView): PrimaryView {
  if (view === 'chat') return 'chat';
  if (view === 'run' || view === 'artifacts') return 'run';
  if (view === 'changes' || view === 'git' || view === 'checks' || view === 'problems')
    return 'changes';
  return 'files';
}
const groupLabel = { develop: 'groupDevelop', verify: 'groupVerify', run: 'groupRun' } as const;

/**
 * A narrow dock's one pane switcher (one pane at a time), at the top left of the 파일 tab's own
 * content. The pane's own tab names the one in front; the switcher reads Panes, not that name
 * again, and still reaches every pane.
 */
export function DockPaneSwitcher({
  panels,
  onSelectPane,
}: {
  panels: { id: string; title: string }[];
  onSelectPane: (id: string) => void;
}) {
  const t = useTranslations('Docking');
  // Opening a pane lists every pane once, under what it is for (#70 IA-04).
  const paneOptions = PANE_CATALOG.filter((entry) => primaryViewFor(entry.view) === 'files').map(
    (entry) => ({
      value: `context:${entry.view}`,
      label: t(entry.view),
      group: t(groupLabel[entry.group]),
    }),
  );
  return (
    <div className="corral-dock-toolbar" data-testid="dock-toolbar">
      <Select<string>
        variant="chip"
        label={t('panes')}
        placeholder={t('panes')}
        value={null}
        onValueChange={(id) => onSelectPane(id)}
        options={[
          ...paneOptions,
          ...panels
            .filter((panel) => panel.id.startsWith('document:') || panel.id.startsWith('graph:'))
            .map((panel) => ({ value: panel.id, label: panel.title })),
        ]}
      />
    </div>
  );
}
