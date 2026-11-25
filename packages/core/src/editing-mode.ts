import type { CorralDefinition } from '@corral/contracts';

type Role = CorralDefinition['roles'][number];

const REPLACE_FAMILIES = [
  /kimi/,
  /mimo/,
  /minimax/,
  /deepseek/,
  /stepfun|step-\d/,
  /codex-spark/,
  /glm-5\.3-flash/,
  /qwen-?3\.8/,
];

export function defaultEditingMode(model: {
  provider: string | null;
  modelId: string | null;
}): 'pi' | 'hashline' {
  if (!model.modelId) return 'pi';
  const name = `${model.provider ?? ''}/${model.modelId}`.toLowerCase();
  return REPLACE_FAMILIES.some((family) => family.test(name)) ? 'pi' : 'hashline';
}

export function withEditingMode(
  role: Role,
  model: { provider: string | null; modelId: string | null },
): Role {
  return role.editingMode === 'model' ? { ...role, editingMode: defaultEditingMode(model) } : role;
}
