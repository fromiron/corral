import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';
import { describeTool, staticToolDescriptors } from '../src/static-tools.ts';

it('keeps cached Pi schemas identical to the installed public factories', () => {
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

it('classifies shell and hashline tools without weakening their side effects', () => {
  expect(staticToolDescriptors(['run_command', 'read_hashline', 'edit_hashline'])).toEqual([
    expect.objectContaining({ name: 'run_command', source: 'corral', sideEffect: 'external' }),
    expect.objectContaining({ name: 'read_hashline', source: 'corral', sideEffect: 'none' }),
    expect.objectContaining({ name: 'edit_hashline', source: 'corral', sideEffect: 'workspace' }),
  ]);
});

it('treats image generation as an external effect with bounded image options', () => {
  expect(staticToolDescriptors(['generate_image'])).toEqual([
    expect.objectContaining({ name: 'generate_image', source: 'corral', sideEffect: 'external' }),
  ]);
});

it('classifies file previews separately from browser and app effects', () => {
  expect(staticToolDescriptors(['preview_file', 'preview_app', 'preview_action'])).toEqual([
    expect.objectContaining({ name: 'preview_file', source: 'corral', sideEffect: 'none' }),
    expect.objectContaining({ name: 'preview_app', source: 'corral', sideEffect: 'external' }),
    expect.objectContaining({ name: 'preview_action', source: 'corral', sideEffect: 'external' }),
  ]);
});
