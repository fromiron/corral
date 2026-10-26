import { describe, expect, it } from 'vitest';
import { toolPermission } from '../src/tool-policy.ts';

describe('permission presets (ABS-02)', () => {
  it('Ask does not interrupt Corral result bookkeeping but preserves explicit asks', () => {
    for (const name of ['write_artifact', 'submit_result']) {
      const descriptor = {
        name,
        source: 'corral' as const,
        exposure: 'direct' as const,
        schemaHash: 'a'.repeat(64),
        sideEffect: 'workspace' as const,
      };
      expect(toolPermission(undefined, { name, args: {} }, undefined, 'ask', descriptor)).toBe(
        'allow',
      );
      expect(
        toolPermission(
          [{ default: 'ask', rules: [] }],
          { name, args: {} },
          undefined,
          'ask',
          descriptor,
        ),
      ).toBe('ask');
    }
  });
  it('a scoped Hashline move grant covers both source and destination', () => {
    const allow = {
      default: 'deny' as const,
      rules: [
        {
          tool: 'edit_hashline',
          action: 'allow' as const,
          descriptorHash: 'a'.repeat(64),
          path: { argument: 'path', prefix: 'src' },
        },
      ],
    };
    const proposal = (ops: string) => ({
      name: 'edit_hashline',
      args: { version: 1, path: 'src/a', tag: 'ABCD', ops },
    });
    expect(toolPermission([allow], proposal('MV src/b'), 'a'.repeat(64), 'auto')).toBe('allow');
    expect(toolPermission([allow], proposal('MV protected/b'), 'a'.repeat(64), 'auto')).toBe(
      'deny',
    );
    expect(
      toolPermission([allow], proposal('[src/a#ABCD]\nMV "protected/b"'), 'a'.repeat(64), 'auto'),
    ).toBe('deny');
    const deny = {
      default: 'ask' as const,
      rules: [
        {
          tool: 'edit_hashline',
          action: 'deny' as const,
          path: { argument: 'path', prefix: 'protected' },
        },
      ],
    };
    expect(toolPermission([deny], proposal('MV protected/b'), undefined, 'auto')).toBe('deny');
    expect(toolPermission([allow], proposal('MV src/b\nCUT 1.=2'), 'a'.repeat(64), 'auto')).toBe(
      'deny',
    );
  });
  it('Ask asks for writes and commands while observation stays allowed', () => {
    expect(toolPermission(undefined, { name: 'write_file', args: {} }, undefined, 'ask')).toBe(
      'ask',
    );
    expect(toolPermission(undefined, { name: 'run_command', args: {} }, undefined, 'ask')).toBe(
      'ask',
    );
    expect(toolPermission(undefined, { name: 'read_file', args: {} }, undefined, 'ask')).toBe(
      'allow',
    );
  });
  it('Accept edits admits managed file edits, but asks for processes', () => {
    expect(toolPermission(undefined, { name: 'edit', args: {} }, undefined, 'accept_edits')).toBe(
      'allow',
    );
    expect(
      toolPermission(undefined, { name: 'run_command', args: {} }, undefined, 'accept_edits'),
    ).toBe('ask');
  });
  it('Auto never defeats existing deny or ask policies; absent mode stays legacy', () => {
    expect(
      toolPermission(
        [{ default: 'deny', rules: [] }],
        { name: 'read_file', args: {} },
        undefined,
        'auto',
      ),
    ).toBe('deny');
    expect(
      toolPermission(
        [{ default: 'ask', rules: [] }],
        { name: 'write_file', args: {} },
        undefined,
        'auto',
      ),
    ).toBe('ask');
    expect(toolPermission(undefined, { name: 'write_file', args: {} }, undefined)).toBe('allow');
  });
});
