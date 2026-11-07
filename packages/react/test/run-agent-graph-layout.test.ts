import { describe, expect, it } from 'vitest';
import type {
  RunAgentGraph,
  RunAgentGraphNode,
  RunAgentGraphRelation,
} from '../src/run/agent-graph.ts';
import { layoutRunAgents } from '../src/run/agent-graph-layout.ts';

function node(id: string, lead = false): RunAgentGraphNode {
  return {
    id,
    label: id,
    executionIds: [`execution_${id}`],
    summary: { status: 'done', counts: { done: 1 }, previousFailures: 0 },
    lead,
  };
}

function relation(source: string, target: string): RunAgentGraphRelation {
  return {
    id: `${source}-${target}`,
    source,
    target,
    kind: 'delegate',
    count: 1,
    activeCount: 0,
    executionIds: [`execution_${source}`, `execution_${target}`],
    artifactVersionIds: [],
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('observed agent layout', () => {
  it('places connected agents together rather than using the authoring graph', () => {
    const graph: RunAgentGraph = {
      nodes: [node('root', true), node('helper'), node('unrelated')],
      relations: [relation('root', 'helper')],
    };
    const positions = layoutRunAgents(graph);
    const root = positions.get('root');
    const helper = positions.get('helper');
    const unrelated = positions.get('unrelated');
    expect(root && helper && unrelated).toBeTruthy();
    if (!root || !helper || !unrelated) throw new Error('Missing agent position');
    expect(distance(root, helper)).toBeLessThan(distance(root, unrelated));
  });

  it('preserves existing positions when statuses change and a connected agent arrives', () => {
    const initial: RunAgentGraph = {
      nodes: [node('root', true), node('helper')],
      relations: [relation('root', 'helper')],
    };
    const positions = layoutRunAgents(initial);
    const next: RunAgentGraph = {
      nodes: [
        {
          ...node('root', true),
          summary: { status: 'active', counts: { active: 1 }, previousFailures: 0 },
        },
        node('helper'),
        node('newcomer'),
      ],
      relations: [...initial.relations, relation('helper', 'newcomer')],
    };
    const updated = layoutRunAgents(next, positions);
    expect(updated.get('root')).toEqual(positions.get('root'));
    expect(updated.get('helper')).toEqual(positions.get('helper'));
    const newcomer = updated.get('newcomer');
    expect(newcomer).toBeDefined();
    expect([...positions.values()]).not.toContainEqual(newcomer);
  });
});
