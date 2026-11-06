import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtHelperPath, helperFileName } from '../src/engine/helper.ts';
import { tempDir } from './helpers.ts';

function place(packageDir: string, dir: string, name: string) {
  mkdirSync(join(packageDir, dir), { recursive: true });
  writeFileSync(join(packageDir, dir, name), '');
  return join(packageDir, dir, name);
}

describe('helper lookup', () => {
  it('prefers the helper shipped in the package over a checkout build', () => {
    const packageDir = tempDir();
    const built = place(packageDir, 'helper/target/release', 'corral-local-ai-helper');
    expect(builtHelperPath('linux', packageDir)).toBe(built);
    const shipped = place(packageDir, 'bin', 'corral-local-ai-helper');
    expect(builtHelperPath('linux', packageDir)).toBe(shipped);
  });

  it('looks for the Windows executable name and reports a missing helper', () => {
    const packageDir = tempDir();
    expect(builtHelperPath('linux', packageDir)).toBeNull();
    place(packageDir, 'bin', 'corral-local-ai-helper');
    expect(builtHelperPath('win32', packageDir)).toBeNull();
    expect(helperFileName('win32')).toBe('corral-local-ai-helper.exe');
    const exe = place(packageDir, 'bin', helperFileName('win32'));
    expect(builtHelperPath('win32', packageDir)).toBe(exe);
  });
});
