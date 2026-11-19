import type { RoleMcpToolProblemReason, RoleMcpToolRef } from '@corral/contracts';

export const docsEcho = { serverId: 'docs', name: 'mcp__docs__echo' };
export const docsEdit = { serverId: 'docs', name: 'mcp__docs__edit' };
export const otherSearch = { serverId: 'other', name: 'mcp__other__search' };
export const inheritedMcpNames = [
  docsEcho.name,
  docsEdit.name,
  otherSearch.name,
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
];

interface RoleMcpCase {
  title: string;
  binding: 'none' | 'strict' | 'native';
  picks?: RoleMcpToolRef[];
  offered?: string[];
  servers?: string[];
  problem?: RoleMcpToolProblemReason;
  disabled?: boolean;
}

export const roleMcpCases: RoleMcpCase[] = [
  { title: 'unchanged unbound role', binding: 'none' },
  { title: 'an empty list without a role layer needs no harness', binding: 'none', picks: [] },
  {
    title: 'no picks inherits all allowed servers and generic resource tools',
    binding: 'native',
    servers: ['docs', 'other'],
    offered: inheritedMcpNames,
  },
  {
    title: 'empty selection disables every server and MCP tool',
    binding: 'native',
    picks: [],
    servers: [],
    offered: [],
  },
  {
    title: 'exactly one tool on one server',
    binding: 'native',
    picks: [docsEcho],
    servers: ['docs'],
    offered: [docsEcho.name],
  },
  {
    title: 'two picks on different servers',
    binding: 'native',
    picks: [docsEdit, otherSearch],
    servers: ['docs', 'other'],
    offered: [docsEdit.name, otherSearch.name],
  },
  {
    title: 'a tool requires an explicit role policy',
    binding: 'none',
    picks: [docsEcho],
    problem: 'execution_policy_required',
  },
  {
    title: 'strict refuses selected tools',
    binding: 'strict',
    picks: [docsEcho],
    problem: 'execution_policy_required',
  },
  {
    title: 'selected server is not installed',
    binding: 'native',
    picks: [{ serverId: 'gone', name: 'mcp__gone__read' }],
    problem: 'server_missing',
  },
  {
    title: 'a disabled selected server is not silently dropped',
    binding: 'native',
    disabled: true,
    picks: [docsEcho],
    problem: 'server_disabled',
  },
  {
    title: 'server must be selected by policy',
    binding: 'native',
    picks: [{ serverId: 'unselected', name: 'mcp__unselected__read' }],
    problem: 'server_not_selected',
  },
  {
    title: 'the selected tool must be allowed by policy',
    binding: 'native',
    picks: [{ serverId: 'docs', name: 'mcp__docs__later' }],
    problem: 'tool_not_allowed',
  },
];
