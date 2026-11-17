import { expect, it } from 'vitest';
import { forgetRetiredKeys } from './retiredStorage.ts';

/** A storage that records what is read and removed. */
function storage(entries: Record<string, string>) {
  const items = new Map(Object.entries(entries));
  const reads: string[] = [];
  return {
    reads,
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => {
      reads.push(key);
      return items.get(key) ?? null;
    },
    removeItem: (key: string) => void items.delete(key),
  };
}

it("deletes the source folder preview's keys without reading them and keeps every other key", () => {
  const kept = {
    'corral:panel:v1:session_a': '{}',
    'corral:file-source:v1:session_a': '"project"',
    'corral:file-preview:v2:session_a:project': '"a.md"',
  };
  const device = storage({
    'corral:file-preview:v1:session_a:project': '"README.md"',
    'corral:file-preview:v1:session_b:session': 'not json',
    ...kept,
  });

  forgetRetiredKeys(device);

  expect(Object.fromEntries(device.items)).toEqual(kept);
  expect(device.reads).toEqual([]);
});

it('leaves a storage that refuses, and no storage, as they are', () => {
  expect(() => forgetRetiredKeys(null)).not.toThrow();
  const refusing = {
    get length(): number {
      throw new Error('storage refused');
    },
    key: () => null,
    removeItem: () => {},
  };
  expect(() => forgetRetiredKeys(refusing)).not.toThrow();
});
