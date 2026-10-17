import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { describeTool, staticToolDescriptors } from '../src/static-tools.ts';

it('[TC-HAR-003-H] keeps cached Pi schemas identical to the installed public factories', () => {
  for (const factory of [
    createReadToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
  ]) {
    const tool = factory('.');
    const annotations =
      tool.name === 'read'
        ? { readOnlyHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
    expect(staticToolDescriptors([tool.name])).toEqual([
      describeTool({ ...tool, annotations }, 'corral'),
    ]);
  }
  expect(staticToolDescriptors(['ask', 'spawn_subagents', 'codemode', 'mcp__docs__echo'])).toEqual(
    [],
  );
});
