import { describe, expect, it } from 'vitest';
import {
  FRESH_TREE,
  fileSourceKey,
  forgetDeletedTree,
  forgetTreeState,
  treeState,
  updateTreeState,
} from './fileTreeState.ts';
import { resetViewMemory } from './viewMemory.ts';

describe('the file tree’s state, one per conversation', () => {
  it('keeps each conversation’s own tree apart', () => {
    updateTreeState('session_a', { query: 'app', searchMode: 'contents' });
    updateTreeState('session_b', (state) => ({
      opened: { scopeKey: 'session:session_b', paths: new Set([...state.opened.paths, 'src']) },
    }));
    expect(treeState('session_a')).toMatchObject({ query: 'app', searchMode: 'contents' });
    expect([...treeState('session_a').opened.paths]).toEqual([]);
    expect(treeState('session_b').query).toBe('');
    expect([...treeState('session_b').opened.paths]).toEqual(['src']);
  });

  it('starts fresh for a conversation it has never seen', () => {
    expect(treeState('session_new')).toBe(FRESH_TREE);
  });

  it('forgets a conversation’s tree, leaving the others', () => {
    updateTreeState('session_a', { resultsOn: true });
    updateTreeState('session_b', { resultsOn: true });
    forgetTreeState('session_a');
    expect(treeState('session_a')).toBe(FRESH_TREE);
    expect(treeState('session_b').resultsOn).toBe(true);
  });

  it('keeps the same state for an update that changes nothing (duplicate)', () => {
    updateTreeState('session_a', { query: 'x' });
    const before = treeState('session_a');
    updateTreeState('session_a', { query: 'x' });
    expect(treeState('session_a')).toBe(before);
  });

  it('forgets every tree when the test memory is reset', () => {
    updateTreeState('session_a', { query: 'x' });
    resetViewMemory();
    expect(treeState('session_a')).toBe(FRESH_TREE);
    // Forgetting what is not there does nothing.
    expect(() => forgetTreeState('session_a')).not.toThrow();
  });
});

describe('deleting a conversation', () => {
  const storage = () => {
    const items = new Map<string, string>();
    return {
      items,
      removeItem: (key: string) => void items.delete(key),
    };
  };

  it('forgets its tree and the source it remembered, leaving other conversations’ sources', () => {
    const device = storage();
    device.items.set(fileSourceKey('session_a'), '"session"');
    device.items.set(fileSourceKey('session_b'), '"project"');
    updateTreeState('session_a', { query: 'x' });
    forgetDeletedTree(device, 'session_a');
    expect(treeState('session_a')).toBe(FRESH_TREE);
    expect([...device.items.keys()]).toEqual([fileSourceKey('session_b')]);
  });

  it('forgets its tree silently when storage throws or is missing (failure)', () => {
    updateTreeState('session_a', { query: 'x' });
    const throwing = {
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => forgetDeletedTree(throwing, 'session_a')).not.toThrow();
    expect(treeState('session_a')).toBe(FRESH_TREE);
    expect(() => forgetDeletedTree(null, 'session_a')).not.toThrow();
  });
});
