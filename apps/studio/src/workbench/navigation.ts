import type { ProjectSummary } from '@corral/core';
import { createContext, useContext } from 'react';

export interface SettingsSearch {
  projectId?: string;
  returnTo?: string;
}

/** Only an existing work surface may be a settings return destination. */
export function workHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\r\n]/.test(value)) return;
  if (
    !/^\/(?:projects(?:\/[^/?#]+)?|sessions\/[^/?#]+(?:\/review)?|corrals\/[^/?#]+\/edit|runs\/[^/?#]+|demo|compare|inbox|library(?:\/(?:teams|templates|resources))?|preview(?:\/[^/?#]+)?)(?:[?#]|$)/.test(
      value,
    )
  )
    return;
  const url = new URL(value, 'http://corral.local');
  if (
    !['newSession', 'draft', 'settings', 'settingsProject'].some((key) => url.searchParams.has(key))
  )
    return value;
  url.searchParams.delete('settings');
  url.searchParams.delete('settingsProject');
  url.searchParams.delete('newSession');
  url.searchParams.delete('draft');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function validateSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const returnTo = workHref(search.returnTo);
  return {
    ...(typeof search.projectId === 'string' && search.projectId.length <= 256 && search.projectId
      ? { projectId: search.projectId }
      : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

export const SettingsNavigationContext = createContext<{
  projects: ProjectSummary[];
  projectId?: string;
  returnTo: string;
  search: SettingsSearch;
  overlay?: boolean;
  section?: string;
  /** The resource Manage opened the dialog to choose, read from history state; never in the address. */
  item?: string;
  link: (
    section: string,
    projectId?: string,
    /** A resource for the section to choose once on opening (features/library.md). */
    item?: string,
  ) => {
    to: string;
    search: Record<string, unknown>;
    hash?: string;
    replace?: boolean;
    resetScroll: false;
    state?: (
      previous: import('@tanstack/react-router').ParsedLocation['state'],
    ) => import('@tanstack/react-router').ParsedLocation['state'];
  };
  close?: () => void;
  selectProject?: (projectId: string) => void;
}>({
  projects: [],
  returnTo: '/projects',
  search: {},
  link: (section, projectId) => standaloneSettingsLink(section, { projectId }),
});

export const useSettingsNavigation = () => useContext(SettingsNavigationContext);

export const SETTINGS_SECTIONS = [
  'general',
  'shortcuts',
  'about',
  'workspace',
  'models',
  'vault',
  'harness',
  'skills',
  'hooks',
  'mcp',
  'defaults',
  'project-defaults',
  'diagnostics',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
/**
 * Settings sections in the order and groups every width shows them (#83): the sidebar and the
 * narrow menu read this one list, so a section keeps its place and scope at any width.
 */
export const SETTINGS_GROUPS = [
  { id: 'app', items: ['general', 'shortcuts', 'vault', 'diagnostics', 'about'] },
  { id: 'agents', items: ['models', 'harness', 'defaults', 'skills', 'hooks'] },
  { id: 'project', items: ['workspace', 'mcp', 'project-defaults'] },
] as const satisfies readonly { id: string; items: readonly SettingsSection[] }[];
export type SettingsOverlaySearch = { settings?: SettingsSection; settingsProject?: string };
export function validateSettingsOverlay(search: Record<string, unknown>): SettingsOverlaySearch {
  if (!SETTINGS_SECTIONS.includes(search.settings as SettingsSection)) return {};
  return {
    settings: search.settings as SettingsSection,
    ...(typeof search.settingsProject === 'string' &&
    search.settingsProject.length > 0 &&
    search.settingsProject.length <= 256
      ? { settingsProject: search.settingsProject }
      : {}),
  };
}
export function withoutSettings(search: object) {
  const {
    settings: _settings,
    settingsProject: _project,
    ...work
  } = search as SettingsOverlaySearch & Record<string, unknown>;
  return work;
}
export function settingsOnlyTransition(
  current: { pathname: string; search: object },
  next: { pathname: string; search: object },
) {
  const sorted = (search: object) =>
    JSON.stringify(Object.entries(withoutSettings(search)).sort(([a], [b]) => a.localeCompare(b)));
  return current.pathname === next.pathname && sorted(current.search) === sorted(next.search);
}
type HistoryState = import('@tanstack/react-router').ParsedLocation['state'];
/** What the dialog keeps in history state; none of it is in the address. */
type SettingsHistoryState = HistoryState & {
  settingsOwner?: string;
  settingsOrigin?: number;
  settingsOneShot?: boolean;
  /** The resource Manage opened the dialog to choose (features/library.md). */
  settingsItem?: string;
};
/** History state for a link into the dialog. A section change inside it keeps who opened it
 * and drops the chosen resource, which belongs to the section Manage opened. */
export function settingsOpenState(
  previous: HistoryState,
  open: { overlay?: boolean; owner: string; oneShot: boolean; item?: string },
): HistoryState {
  const rest = withoutSettingsItem(previous);
  const base: SettingsHistoryState = open.overlay
    ? rest
    : {
        ...rest,
        settingsOwner: open.owner,
        settingsOrigin: previous.__TSR_index,
        settingsOneShot: open.oneShot,
      };
  if (open.item) base.settingsItem = open.item;
  return base;
}
export function withoutSettingsItem(previous: HistoryState): HistoryState {
  const { settingsItem: _item, ...rest } = previous as SettingsHistoryState;
  return rest;
}
export function settingsClosedState(previous: HistoryState): HistoryState {
  const {
    settingsOwner: _owner,
    settingsOrigin: _origin,
    settingsOneShot: _oneShot,
    settingsItem: _item,
    ...rest
  } = previous as SettingsHistoryState;
  return rest;
}
export function settingsItemOf(state: unknown): string | undefined {
  const item = (state as { settingsItem?: unknown } | undefined)?.settingsItem;
  return typeof item === 'string' && item.length > 0 && item.length <= 1024 ? item : undefined;
}
export function standaloneSettingsLink(section: string, search: SettingsSearch = {}) {
  const general = ['general', 'shortcuts', 'about', 'workspace', 'diagnostics'].includes(section);
  return {
    to: general ? '/settings' : `/settings/${section}`,
    search: { ...search, ...(general ? { section } : {}) },
    resetScroll: false as const,
  };
}

/** Window/desktop command listeners must honor the same modal boundary as DOM focus. */
export function settingsInteractionBlocked() {
  return Boolean(document.querySelector('[data-settings-dialog], [data-settings-guard]'));
}
