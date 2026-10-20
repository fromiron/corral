import {
  canonicalJson,
  type EffectiveHarnessSnapshot,
  hashlineEffectPaths,
  type PermissionMode,
  ResourcePath,
  type ToolDescriptor,
  type ToolPermissionPlan,
  type ToolPermissionPolicy,
  type ToolProposal,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Additional restrictions only: callers must still enforce role/strict/broker capabilities. */
export function toolPermission(
  policies: EffectiveHarnessSnapshot['permissionPolicies'],
  proposal: ToolProposal,
  descriptorHash: string | undefined,
  mode?: PermissionMode,
  descriptor?: ToolDescriptor,
): 'allow' | 'ask' | 'deny' {
  if (
    mode === undefined &&
    ['generate_image', 'preview_app', 'preview_action'].includes(proposal.name)
  )
    mode = 'ask';
  let result: 'allow' | 'ask' = 'allow';
  for (const policy of policies ?? []) {
    const matches = policy.rules.filter(
      (rule) =>
        rule.tool === proposal.name &&
        (!rule.descriptorHash || rule.descriptorHash === descriptorHash) &&
        Object.entries(rule.arguments ?? {}).every(
          ([key, value]) => Object.hasOwn(proposal.args, key) && proposal.args[key] === value,
        ) &&
        (!rule.path || matchesPathRule(proposal, rule)),
    );
    if (matches.some((rule) => rule.action === 'deny')) return 'deny';
    const specificity = (rule: ToolPermissionPolicy['rules'][number]) =>
      Object.keys(rule.arguments ?? {}).length +
      Number(Boolean(rule.path)) +
      Number(Boolean(rule.descriptorHash));
    matches.sort(
      (a, b) =>
        specificity(b) - specificity(a) || Number(b.action === 'ask') - Number(a.action === 'ask'),
    );
    const action = matches[0]?.action ?? policy.default;
    if (action === 'deny') return 'deny';
    if (action === 'ask') result = 'ask';
  }
  if (result === 'ask' || mode === undefined || mode === 'auto') return result;
  if (
    (!descriptor || descriptor.source === 'corral') &&
    [
      'write_artifact',
      'submit_result',
      'update_plan',
      'ask_user',
      'spawn_subagents',
      'await_tasks',
      'ask',
      'reply',
      'read_artifact',
    ].includes(proposal.name)
  )
    return result;
  const edits = ['write_file', 'delete_file', 'move_file', 'edit', 'write', 'edit_hashline'];
  const processes = [
    'run_command',
    'run_check',
    'lsp_query',
    'generate_image',
    'preview_app',
    'preview_action',
  ];
  if (edits.includes(proposal.name)) return mode === 'ask' ? 'ask' : 'allow';
  if (processes.includes(proposal.name) || (descriptor && descriptor.sideEffect !== 'none'))
    return 'ask';
  return result;
}

function matchesPathRule(
  proposal: ToolProposal,
  rule: ToolPermissionPolicy['rules'][number],
): boolean {
  if (!rule.path) return true;
  if (proposal.name !== 'edit_hashline' || rule.path.argument !== 'path')
    return withinPath(proposal.args[rule.path.argument], rule.path.prefix);
  const paths = hashlineEffectPaths(proposal.args);
  // Ambiguous moves cannot obtain a scoped allow. Denials cannot be escaped by malformed ops.
  if (!paths) return rule.action !== 'allow';
  return rule.action === 'allow'
    ? paths.every((path) => withinPath(path, rule.path!.prefix))
    : paths.some((path) => withinPath(path, rule.path!.prefix));
}

function withinPath(value: unknown, prefix: string): boolean {
  const path = ResourcePath.safeParse(value);
  return path.success && (path.data === prefix || path.data.startsWith(`${prefix}/`));
}

export const toolDescriptorHash = (descriptor: ToolDescriptor) => hash(descriptor);
const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
export function toolPermissionPlan(
  snapshot: Pick<EffectiveHarnessSnapshot, 'snapshotHash' | 'policyRevision'>,
  descriptor: ToolDescriptor,
  args: Record<string, unknown>,
): ToolPermissionPlan {
  const details = {
    purpose: 'tool' as const,
    descriptor,
    arguments: args,
    descriptorHash: hash(descriptor),
    argumentsHash: hash(args),
    snapshotHash: snapshot.snapshotHash,
    policyRevision: snapshot.policyRevision,
  };
  return { ...details, fingerprint: hash(details) };
}
export function validToolPermissionPlan(plan: ToolPermissionPlan): boolean {
  return (
    canonicalJson(plan) === canonicalJson(toolPermissionPlan(plan, plan.descriptor, plan.arguments))
  );
}
