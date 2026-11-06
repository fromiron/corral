import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupLegacyJudge } from '../src/legacy.ts';
import {
  cpuThreads,
  dataBase,
  defaultLocalAiDir,
  legacyJudgeDir,
  runtimeTarget,
} from '../src/platform.ts';
import { tempDir, testBundle } from './helpers.ts';

describe('removed effort judge cleanup', () => {
  it('removes the files the judge installed and the folder once it is empty', () => {
    const dir = join(tempDir(), 'effort-judge');
    mkdirSync(dir);
    for (const name of [
      'model.onnx',
      'tokenizer.json',
      'calibration.json',
      'install.json',
      'tokenizer.bin',
      'model.onnx.part',
    ])
      writeFileSync(join(dir, name), 'x');
    expect(cleanupLegacyJudge(dir)).toEqual({ removed: 6, kept: [] });
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps files it did not install, and the folder with them', () => {
    const dir = join(tempDir(), 'effort-judge');
    mkdirSync(dir);
    writeFileSync(join(dir, 'model.onnx'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, 'nested'));
    expect(cleanupLegacyJudge(dir)).toEqual({ removed: 1, kept: ['nested', 'notes.txt'] });
    expect(readdirSync(dir).sort()).toEqual(['nested', 'notes.txt']);
  });

  it('does nothing when there is no judge folder', () => {
    expect(cleanupLegacyJudge(join(tempDir(), 'missing'))).toEqual({ removed: 0, kept: [] });
  });
});

describe('platform', () => {
  it('uses physical cores, at most six', () => {
    expect(cpuThreads('x64', 12)).toBe(6);
    expect(cpuThreads('x64', 8)).toBe(4);
    expect(cpuThreads('x64', 32)).toBe(6);
    expect(cpuThreads('x64', 1)).toBe(1);
    expect(cpuThreads('arm64', 4)).toBe(4);
    expect(cpuThreads('arm64', 10)).toBe(6);
  });

  it('names a target only when the bundle ships a library for it', () => {
    const bundle = testBundle();
    expect(runtimeTarget(bundle, 'linux', 'x64')).toBe('linux-x64');
    expect(runtimeTarget(bundle, 'darwin', 'x64')).toBeNull();
  });

  it('keeps bundles and the old judge in the OS data folder', () => {
    const base = dataBase({ XDG_DATA_HOME: '/data' }, 'linux', '/home/u');
    expect(base).toBe('/data');
    expect(defaultLocalAiDir(base)).toBe(join('/data', 'corral', 'local-ai'));
    expect(legacyJudgeDir(base)).toBe(join('/data', 'corral', 'effort-judge'));
    expect(dataBase({}, 'darwin', '/Users/u')).toBe(
      join('/Users/u', 'Library', 'Application Support'),
    );
    expect(dataBase({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe('C:\\L');
  });
});
