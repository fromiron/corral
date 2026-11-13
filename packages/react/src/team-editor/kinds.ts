import type { CorralDefinition, CorralNode } from '@corral/contracts';
import {
  Bot,
  Eye,
  Flag,
  GitBranch,
  GitMerge,
  ListChecks,
  type LucideIcon,
  Repeat2,
  Route,
  ShieldCheck,
  UserCheck,
  Users,
} from '../ui/icons.ts';
import type { StepKind } from './commands.ts';

// What each kind of step looks like in the team editor: its icon and badge colour, shared by the
// canvas, the structure outline and the command menu.

/** What a node is on screen: a step kind, or an agent that runs only when called. */
export type NodeKind = StepKind | 'callable';

export function kindOf(node: CorralNode): NodeKind {
  switch (node.type) {
    case 'agent':
      return node.invocation === 'scheduled' ? 'agent' : node.invocation;
    case 'decision':
      return node.mode;
    default:
      return node.type;
  }
}

export const KIND_ICON: Record<NodeKind, LucideIcon> = {
  agent: Bot,
  callable: Bot,
  observer: Eye,
  review: ShieldCheck,
  approval: UserCheck,
  rule: GitBranch,
  check: ListChecks,
  router: Route,
  loop: Repeat2,
  team: Users,
  join: GitMerge,
  output: Flag,
};

export type KindColor = 'gray' | 'violet' | 'amber' | 'blue' | 'green' | 'teal';

export const KIND_COLOR: Record<NodeKind, KindColor> = {
  agent: 'violet',
  callable: 'violet',
  observer: 'violet',
  review: 'amber',
  approval: 'amber',
  rule: 'amber',
  check: 'amber',
  router: 'amber',
  loop: 'blue',
  team: 'teal',
  join: 'gray',
  output: 'green',
};

/** The steps the editor offers to add, in the order the palette and the command menu list them. */
export const ADDABLE: StepKind[] = [
  'agent',
  'observer',
  'review',
  'approval',
  'check',
  'router',
  'rule',
  'loop',
  'team',
  'join',
  'output',
];

export const DECISION_KINDS: ReadonlySet<StepKind> = new Set([
  'review',
  'approval',
  'rule',
  'check',
  'router',
]);

/** The role an agent node plays, when it has one. */
export function roleOf(definition: Pick<CorralDefinition, 'roles'>, node: CorralNode | undefined) {
  if (node?.type !== 'agent') return undefined;
  return definition.roles.find((role) => role.id === node.roleId);
}

/** Every node inside a box, at any depth. */
export function membersOf(
  definition: Pick<CorralDefinition, 'nodes'>,
  boxId: string,
): CorralNode[] {
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  return definition.nodes.filter((node) => {
    const seen = new Set<string>();
    for (let at = node.parentId; at && !seen.has(at); at = byId.get(at)?.parentId) {
      if (at === boxId) return true;
      seen.add(at);
    }
    return false;
  });
}
