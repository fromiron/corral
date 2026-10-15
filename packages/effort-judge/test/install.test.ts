import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installModel, installState, type ModelManifest } from '../src/install.ts';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-model-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const manifest = (files: Record<string, string>, release = 'test-v1'): ModelManifest => ({
  schema_version: 1,
  release,
  files: Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      { url: `https://example.test/${name}`, sha256: sha(body), size: Buffer.byteLength(body) },
    ]),
  ),
});
const serve =
  (bodies: Record<string, string>, calls: string[] = []) =>
  async (url: string | URL | Request) => {
    const name = String(url).split('/').pop() ?? '';
    calls.push(name);
    const body = bodies[name];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
  };

describe('model install (C-072)', () => {
  it('[TC-DEC-001-H] downloads each file, checks size and sha256, then stamps the release', async () => {
    const dir = temp();
    const files = { 'model.onnx': 'weights', 'calibration.json': '{"temperature":1}' };
    expect(installState(dir, manifest(files))).toBe('missing');
    await installModel(dir, { manifest: manifest(files), fetchFn: serve(files) });
    expect(readFileSync(join(dir, 'model.onnx'), 'utf8')).toBe('weights');
    expect(installState(dir, manifest(files))).toBe('current');
    expect(installState(dir, manifest(files, 'test-v2'))).toBe('stale');
  });

  it('[TC-DEC-001-N] a wrong hash, a short or oversized body leaves no stamp and keeps a working file', async () => {
    const dir = temp();
    const good = { 'model.onnx': 'weights' };
    await installModel(dir, { manifest: manifest(good), fetchFn: serve(good) });
    const next = manifest({ 'model.onnx': 'weights-v2' }, 'test-v2');
    for (const body of ['tampered!!', 'short', 'weights-v2-plus-more-bytes']) {
      await expect(
        installModel(dir, { manifest: next, fetchFn: serve({ 'model.onnx': body }) }),
      ).rejects.toThrow();
      expect(readFileSync(join(dir, 'model.onnx'), 'utf8')).toBe('weights');
      expect(existsSync(join(dir, 'model.onnx.part'))).toBe(false);
    }
    // The previous complete install is still the one that loads.
    expect(installState(dir, manifest(good))).toBe('current');
  });

  it('[TC-DEC-001-N] files that already match are not downloaded again; http URLs are refused', async () => {
    const dir = temp();
    const files = { 'model.onnx': 'weights' };
    await installModel(dir, { manifest: manifest(files), fetchFn: serve(files) });
    const calls: string[] = [];
    await installModel(dir, { manifest: manifest(files), fetchFn: serve(files, calls) });
    expect(calls).toEqual([]);
    const insecure = manifest(files);
    (insecure.files['model.onnx'] as { url: string }).url = 'http://example.test/model.onnx';
    await expect(
      installModel(temp(), { manifest: insecure, fetchFn: serve(files) }),
    ).rejects.toThrow(/manifest/);
    writeFileSync(join(dir, 'install.json'), '{broken');
    expect(installState(dir, manifest(files))).toBe('missing');
  });
});
