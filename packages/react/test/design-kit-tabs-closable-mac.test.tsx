import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { File, GitCompare, Play } from 'lucide-react';
import { useState } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TabsClosable, type TabsClosableTab } from '../src/design-kit/adapters/tabs-closable.tsx';

// On a Mac the reorder chord is ⌘⇧ and arrows; Ctrl+Shift is not it. The kit reads the platform
// once per module, so this file has its own.

const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
beforeAll(() => {
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => 'MacIntel',
  });
});
afterAll(() => {
  if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
});

const sample: TabsClosableTab[] = [
  { id: 'files', label: '파일', icon: File },
  { id: 'changes', label: '변경', icon: GitCompare },
  { id: 'run-1', label: '실행 #1', icon: Play },
];

function Reorderable({ onReorder }: { onReorder: (id: string, to: number) => void }) {
  const [tabs, setTabs] = useState(sample);
  return (
    <TabsClosable
      aria-label="패널"
      idPrefix="panel"
      tabs={tabs}
      selectedId="files"
      onSelect={() => {}}
      onClose={() => {}}
      closeLabel={(tab) => `${tab.label} 닫기`}
      onReorder={(id, to) => {
        onReorder(id, to);
        setTabs((current) => {
          const rest = current.filter((tab) => tab.id !== id);
          const tab = current.find((item) => item.id === id) as TabsClosableTab;
          return [...rest.slice(0, to), tab, ...rest.slice(to)];
        });
      }}
      announceMove={(tab, position, count) => `${tab.label}: ${position}번째 / ${count}개`}
    />
  );
}

it('moves the focused tab with ⌘⇧ and arrows on a Mac, and not with Ctrl+Shift', async () => {
  const onReorder = vi.fn();
  render(<Reorderable onReorder={onReorder} />);
  const user = userEvent.setup();
  const changes = screen.getByRole('tab', { name: '변경' });
  expect(changes).toHaveAttribute(
    'aria-keyshortcuts',
    'Delete Meta+Shift+ArrowLeft Meta+Shift+ArrowRight',
  );
  changes.focus();
  await user.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}');
  expect(onReorder).not.toHaveBeenCalled();
  await user.keyboard('{Meta>}{Shift>}{ArrowLeft}{/Shift}{/Meta}');
  expect(onReorder).toHaveBeenCalledExactlyOnceWith('changes', 0);
  expect(screen.getByRole('tab', { name: '변경' })).toHaveFocus();
});
