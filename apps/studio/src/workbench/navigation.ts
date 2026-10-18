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
    !/^\/(?:projects(?:\/[^/?#]+)?|sessions\/[^/?#]+(?:\/review)?|corrals\/[^/?#]+\/edit|runs\/[^/?#]+|demo|compare)(?:[?#]|$)/.test(
      value,
    )
  )
    return;
  const url = new URL(value, 'http://corral.local');
  if (!url.searchParams.has('newSession') && !url.searchParams.has('draft')) return value;
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
}>({ projects: [], returnTo: '/projects', search: {} });

export const useSettingsNavigation = () => useContext(SettingsNavigationContext);
