import { expect, it } from 'vitest';
import { openedFilePaths } from './FilePanel.tsx';

it('[TC-WBD-003-N] opening a twenty-first file cannot silently remove an existing tab', () => {
  const paths = Array.from({ length: 20 }, (_, index) => `file-${index}.ts`);
  expect(openedFilePaths(paths, 'next.ts')).toBeNull();
  expect(openedFilePaths(paths, paths[0] as string)).toEqual(paths);
  expect(openedFilePaths(paths.slice(1), 'next.ts')).toEqual([...paths.slice(1), 'next.ts']);
  expect(paths).toHaveLength(20);
});
