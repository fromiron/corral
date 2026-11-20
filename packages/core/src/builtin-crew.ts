import type { CollaborationTool, OutputContract, WorkTool } from '@corral/contracts';

/**
 * The bundled skills and agents (docs/specs/features/builtin-crew.md). The data is generated
 * from apps/server/resources/builtin by `pnpm builtin:generate`; these are its shapes.
 */
export interface BuiltinSkill {
  name: string;
  description: string;
  /** The bundled pack id, a folder of apps/server/resources/builtin. */
  pack: string;
  /** The pack's content hash, as installation computes it. */
  resourceHash: string;
  /** The skill's SKILL.md relative to the pack root. */
  entry: string;
}

export interface BuiltinSkillRef {
  name: string;
  resourceHash: string;
  entry: string;
}

export interface BuiltinAgent {
  /** The agent file's name, and the role preset's id. */
  id: string;
  description: string;
  workTools: readonly WorkTool[];
  collaborationTools: readonly CollaborationTool[];
  outputContract: OutputContract;
  modelSlot: 'a' | 'b';
  /** The agent file's body: the role's base instruction before the common work rules. */
  prompt: string;
  skills: readonly BuiltinSkillRef[];
}

export { BUILTIN_AGENTS, BUILTIN_SKILLS } from './generated/builtin-crew.ts';
